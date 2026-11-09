#!/usr/bin/env node
// B200 Studio worker — runs on the Mac Mini (which is on the Research Warrant VPN).
// It asks the website for new prompts, runs them on the B200's ComfyUI, and uploads the finished clip.
// Only outgoing connections: nothing on this Mac is exposed to the internet.
//
//   node worker.mjs                         run forever
//   node worker.mjs --check                 test the setup once and exit
//   node worker.mjs --list                  show the models this worker offers
//   node worker.mjs --discover              look through ComfyUI's history for working Wan/LTX/… runs to use
//   node worker.mjs --import <prompt_id> [--as wan] [--label "Wan 2.2"]   use a specific ComfyUI run
//   node worker.mjs --import-file workflow_api.json [--as ltx] [--label "LTX"]
//   node worker.mjs --remove <model_id>
//
// Every model is a graph copied from a run that already worked; a job only changes its prompt and seed.
//
// ComfyUI calls go through `curl` on purpose: macOS curl trusts the VPN root CA from the keychain,
// while Node would need extra certificate setup.

import { spawn } from "node:child_process"
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { FAMILIES, applyJob, buildH3, buildModel, classify, hasModel, loadModels, needsImage, saveModel } from "./models.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const cfgPath = process.env.STUDIO_CONFIG || join(HERE, "config.json")
if (!existsSync(cfgPath)) {
  console.error(`Missing ${cfgPath}. Copy config.example.json to config.json and fill it in.`)
  process.exit(1)
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"))
const STUDIO = String(process.env.STUDIO_URL || cfg.studioUrl).replace(/\/$/, "")
const TOKEN = process.env.WORKER_TOKEN || cfg.workerToken
const COMFY = String(process.env.COMFY_URL || cfg.comfyUrl).replace(/\/$/, "")
const TEMPLATE_ID = cfg.templateHistoryId
const POLL = (cfg.pollSeconds || 30) * 1000
const CHUNK = 3_000_000
const MAX_RUN_MS = 45 * 60 * 1000

const MODELS_DIR = join(HERE, "models")
const DISCOVER_EVERY = 30 * 60 * 1000

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- curl helpers (ComfyUI) ----------
function curl(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn("curl", ["-sS", "--fail-with-body", ...args])
    let out = Buffer.alloc(0)
    let err = ""
    p.stdout.on("data", (d) => (out = Buffer.concat([out, d])))
    p.stderr.on("data", (d) => (err += d))
    p.on("error", reject)
    p.on("close", (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`curl exit ${code}: ${(err || out.toString()).trim().slice(0, 300)}`))
    })
    if (input !== undefined) p.stdin.end(input)
    else p.stdin.end()
  })
}
const comfyGet = async (path, timeout = 30) => JSON.parse((await curl(["-m", String(timeout), COMFY + path])).toString())
const comfyPost = async (path, body) =>
  JSON.parse(
    (await curl(["-m", "60", "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@-", COMFY + path], JSON.stringify(body))).toString(),
  )

// ---------- website helpers ----------
// Retries network errors and 5xx responses (home internet blips) before giving up.
async function studio(path, { method = "POST", body, raw } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res
    try {
      res = await fetch(STUDIO + path, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, ...(raw ? { "content-type": "application/octet-stream" } : { "content-type": "application/json" }) },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(90_000),
      })
    } catch (e) {
      if (attempt >= 5) throw new Error(`website unreachable: ${e.message}`)
      await sleep(2000 * attempt)
      continue
    }
    const text = await res.text()
    if (res.status >= 500 && attempt < 5) {
      await sleep(2000 * attempt)
      continue
    }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`)
    return text ? JSON.parse(text) : {}
  }
}

// ---------- GPU status ----------
let lastGpu = null
async function heartbeat(extra = {}) {
  try {
    const s = await comfyGet("/system_stats", 10)
    const dev = (s.devices || [])[0] || {}
    lastGpu = { gpu: String(dev.name || "GPU").replace(/^cuda:\d+\s*/, "").replace(/\s*:\s*cudaMalloc.*$/, ""), vramGB: dev.vram_total ? Math.round(dev.vram_total / 2 ** 30) : undefined }
    return { comfyOk: true, ...lastGpu, ...extra }
  } catch (e) {
    return { comfyOk: false, comfyError: describeComfyError(e), ...extra }
  }
}
function describeComfyError(e) {
  const m = String(e.message || e)
  if (/resolve host/i.test(m)) return "Can't find the GPU server — the Research Warrant VPN is probably off."
  if (/certificate|SSL/i.test(m)) return "TLS/certificate problem talking to the GPU server."
  if (/timed out|timeout/i.test(m)) return "The GPU server isn't responding."
  return m.slice(0, 200)
}

// ---------- models ----------
let models = loadModels(MODELS_DIR)
const famOrder = (id) => {
  const i = FAMILIES.findIndex((f) => f.id === id)
  return i < 0 ? 99 : i
}
const modelList = () =>
  [...models.values()].sort((a, b) => famOrder(a.id) - famOrder(b.id)).map((m) => ({ id: m.id, label: m.label, note: m.note || "", expectedSecs: Math.round(m.avgSecs || 240) }))

async function ensureH3() {
  if (models.has("h3")) return
  const legacy = join(HERE, "template.json") // from the first version of this worker
  let graph = existsSync(legacy) ? JSON.parse(readFileSync(legacy, "utf8")) : null
  if (!graph && TEMPLATE_ID) {
    const h = await comfyGet(`/history/${TEMPLATE_ID}`)
    graph = h[TEMPLATE_ID]?.prompt?.[2]
    if (!graph) throw new Error(`H3 run ${TEMPLATE_ID} isn't in ComfyUI's history any more (it resets when ComfyUI restarts)`)
  }
  if (!graph) return
  const m = buildH3(graph, TEMPLATE_ID)
  saveModel(MODELS_DIR, m)
  models.set(m.id, m)
  log(`+ model ready: ${m.label}`)
}

/** Newest successful text-to-video run per model family that we don't have yet. */
async function discover({ verbose = false } = {}) {
  const hist = await comfyGet("/history?max_items=500", 180)
  const best = new Map()
  for (const [pid, e] of Object.entries(hist)) {
    const graph = e?.prompt?.[2]
    const okRun = e?.status?.status_str === "success" || e?.status?.completed
    if (!graph || !okRun || !findVideo(e.outputs)) continue
    const c = classify(graph)
    if (!c) continue
    const why = c.family.discover === false ? "H3 only uses the hand-checked run" : needsImage(graph) ? "needs a starting image" : hasModel(MODELS_DIR, c.family.id) ? "already set up" : ""
    if (verbose) console.log(`  ${pid}  ${c.family.label.padEnd(12)} ${c.file}${why ? `  (skipped: ${why})` : ""}`)
    if (why) continue
    const num = Number(e.prompt[0]) || 0
    if (!best.has(c.family.id) || num > best.get(c.family.id).num) best.set(c.family.id, { pid, graph, num })
  }
  const added = []
  for (const { pid, graph } of best.values()) {
    try {
      const m = buildModel({ graph, sourcePromptId: pid })
      saveModel(MODELS_DIR, m)
      models.set(m.id, m)
      added.push(m)
      log(`+ model ready: ${m.label} (from ComfyUI run ${pid})`)
    } catch (e) {
      log(`! couldn't use run ${pid}: ${e.message}`)
    }
  }
  return added
}

let lastDiscover = 0
async function refreshModels() {
  if (Date.now() - lastDiscover < DISCOVER_EVERY) return
  lastDiscover = Date.now()
  try {
    await ensureH3()
  } catch (e) {
    log("! H3: " + e.message)
  }
  try {
    await discover()
  } catch (e) {
    log("! model discovery: " + e.message)
  }
}

// ---------- running one job ----------
async function update(job, patch) {
  const r = await studio("/api/worker/update", { body: { id: job.id, patch, heartbeat: { comfyOk: true, ...lastGpu, models: modelList(), busy: true } } })
  return r.cancelled
}

function findVideo(outputs) {
  const files = []
  for (const out of Object.values(outputs || {}))
    for (const list of Object.values(out))
      if (Array.isArray(list)) for (const f of list) if (f && typeof f === "object" && f.filename) files.push(f)
  return files.find((f) => /\.(mp4|webm|mov)$/i.test(f.filename)) || null
}

async function runJob(job) {
  const model = models.get(job.model || "h3")
  if (!model) throw new Error(`The ${job.modelLabel || job.model} model isn't set up on the GPU machine`)
  log(`▶ ${job.id} [${model.label}] "${job.prompt.slice(0, 60)}" — ${job.name}`)
  let pid = job.comfyPromptId
  let genStartedAt = job.genStartedAt

  if (pid) {
    // Resuming after a restart: is ComfyUI still aware of it?
    const h = await comfyGet(`/history/${pid}`)
    const q = await comfyGet("/queue")
    const inQueue = [...q.queue_running, ...q.queue_pending].some((it) => it[1] === pid)
    if (!h[pid] && !inQueue) pid = null
    else log(`  resuming GPU job ${pid}`)
  }
  if (!pid) {
    const r = await comfyPost("/prompt", { prompt: applyJob(model, job), client_id: "b200-studio" })
    if (r.node_errors && Object.keys(r.node_errors).length) throw new Error("ComfyUI rejected the workflow: " + JSON.stringify(r.node_errors).slice(0, 300))
    pid = r.prompt_id
    log(`  submitted as ${pid}`)
    if (await update(job, { comfyPromptId: pid, note: "Waiting for the GPU" })) return cancelOnGpu(pid)
  }

  const t0 = Date.now()
  let lastNote = ""
  let lastPush = 0
  while (true) {
    if (Date.now() - t0 > MAX_RUN_MS) throw new Error("Timed out after 45 minutes on the GPU")
    const h = await comfyGet(`/history/${pid}`)
    const entry = h[pid]
    if (entry) {
      const st = entry.status || {}
      if (st.status_str === "error") {
        const msg = (st.messages || []).find((m) => m[0] === "execution_error")
        throw new Error("GPU error: " + (msg ? msg[1].exception_message : "unknown").toString().trim().slice(0, 300))
      }
      if (st.completed || st.status_str === "success") {
        const file = findVideo(entry.outputs)
        if (!file) throw new Error("The GPU finished but produced no video file")
        if (genStartedAt) learnTiming(model, (Date.now() - genStartedAt) / 1000)
        return deliver(job, file)
      }
    }
    const q = await comfyGet("/queue")
    let note
    if (q.queue_running.some((it) => it[1] === pid)) {
      if (!genStartedAt) genStartedAt = Date.now()
      note = "Generating"
    } else {
      const idx = q.queue_pending.findIndex((it) => it[1] === pid)
      const busy = q.queue_running.length
      note = idx < 0 ? "Finishing up" : `Waiting for the GPU (${idx + busy} other job${idx + busy === 1 ? "" : "s"} ahead)`
    }
    if (note !== lastNote || Date.now() - lastPush > 60_000) {
      if (await update(job, { note, genStartedAt: genStartedAt || null })) return cancelOnGpu(pid)
      lastNote = note
      lastPush = Date.now()
    }
    await sleep(8000)
  }
}

function learnTiming(model, secs) {
  if (!(secs > 5 && secs < 3 * 3600)) return
  model.avgSecs = model.measured ? Math.round(model.avgSecs * 0.6 + secs * 0.4) : Math.round(secs)
  model.measured = (model.measured || 0) + 1
  try {
    saveModel(MODELS_DIR, model)
  } catch {}
}

async function cancelOnGpu(pid) {
  log("  cancelled on the website — removing from GPU queue")
  try {
    await comfyPost("/queue", { delete: [pid] })
  } catch {}
}

async function deliver(job, file) {
  await update(job, { note: "Uploading the clip" })
  const dir = mkdtempSync(join(tmpdir(), "b200-studio-"))
  const out = join(dir, "clip")
  try {
    const qs = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" })
    await curl(["-m", "600", "-o", out, `${COMFY}/view?${qs}`])
    const buf = readFileSync(out)
    const chunks = Math.ceil(buf.length / CHUNK)
    for (let i = 0; i < chunks; i++) {
      const part = buf.subarray(i * CHUNK, (i + 1) * CHUNK)
      for (let attempt = 1; ; attempt++) {
        try {
          await studio(`/api/worker/upload/${job.id}/${i}`, { method: "PUT", raw: part })
          break
        } catch (e) {
          if (attempt >= 4) throw e
          await sleep(2000 * attempt)
        }
      }
    }
    const type = file.filename.endsWith(".webm") ? "video/webm" : file.filename.endsWith(".mov") ? "video/quicktime" : "video/mp4"
    const nice = job.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "clip"
    await studio("/api/worker/finish", {
      body: { id: job.id, video: { chunks, size: buf.length, type, filename: `${nice}-${job.seed}.${file.filename.split(".").pop()}` } },
    })
    log(`  ✓ done (${(buf.length / 1e6).toFixed(1)} MB, ${chunks} chunk${chunks > 1 ? "s" : ""})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- main loop ----------
let stopping = false
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  if (stopping) process.exit(1)
  stopping = true
  log("Stopping after the current step (Ctrl-C again to force)")
})

async function check() {
  let ok = true
  const say = (good, msg) => {
    console.log(`${good ? "✓" : "✗"} ${msg}`)
    if (!good) ok = false
  }
  const hb = await heartbeat()
  say(hb.comfyOk, hb.comfyOk ? `GPU server reachable: ${hb.gpu}${hb.vramGB ? ` (${hb.vramGB} GB)` : ""}` : `GPU server: ${hb.comfyError}`)
  if (hb.comfyOk) {
    lastDiscover = 0
    await refreshModels()
    say(models.size > 0, models.size ? `${models.size} model${models.size > 1 ? "s" : ""} ready:` : "No models ready (see README: 'Adding models')")
    for (const m of models.values()) {
      try {
        applyJob(m, { prompt: "test", seed: 1 })
        const [pid, pk] = m.fields.prompt
        console.log(`    ${m.id.padEnd(8)} ${m.label.padEnd(18)} prompt→${pid}.${pk}  seed→${m.fields.seeds.map((x) => x.join(".")).join(", ") || "(none)"}  ~${Math.round(m.avgSecs)}s`)
      } catch (e) {
        say(false, `${m.id}: ${e.message}`)
      }
    }
  }
  try {
    await studio("/api/worker/update", { body: { id: "check", heartbeat: { ...hb, models: modelList() } } }).catch((e) => {
      if (!/404/.test(e.message)) throw e
    })
    say(true, `Website reachable and worker token accepted: ${STUDIO}`)
  } catch (e) {
    say(false, "Website: " + e.message)
  }
  process.exit(ok ? 0 : 1)
}

async function main() {
  log(`B200 Studio worker → ${STUDIO}`)
  let lastState = ""
  while (!stopping) {
    let job = null
    try {
      let hb = await heartbeat()
      if (hb.comfyOk) await refreshModels()
      hb = { ...hb, models: modelList() }
      if (hb.comfyOk && !models.size) hb = { ...hb, comfyOk: false, comfyError: "No video models are set up on the GPU machine yet." }
      const state = hb.comfyOk ? "GPU reachable" : hb.comfyError
      if (state !== lastState) log(hb.comfyOk ? `● ${state} (${hb.gpu})` : `○ ${state}`)
      lastState = state
      job = (await studio("/api/worker/claim", { body: { heartbeat: hb } })).job
    } catch (e) {
      log("! " + e.message)
    }
    if (job) {
      try {
        await runJob(job)
      } catch (e) {
        log(`  ✗ ${e.message}`)
        const vpn = /curl exit (6|7|28|35|52|56|60)|website unreachable| -> 5\d\d /.test(e.message)
        if (vpn) {
          log("  (connection problem — will pick this job up again shortly; the GPU result is kept)")
          await sleep(POLL)
        } else {
          await studio("/api/worker/fail", { body: { id: job.id, error: e.message } }).catch((err) => log("! " + err.message))
        }
      }
      continue
    }
    await sleep(POLL)
  }
}

const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

async function cli() {
  if (argv.includes("--check")) return check()
  if (argv.includes("--list")) {
    if (!models.size) console.log("No models yet. Run --discover or --import.")
    for (const m of models.values()) console.log(`${m.id.padEnd(8)} ${m.label.padEnd(18)} ~${Math.round(m.avgSecs)}s  ${m.source}`)
    return
  }
  if (argv.includes("--discover")) {
    console.log("Successful video runs in ComfyUI's history:")
    const added = await discover({ verbose: true })
    console.log(added.length ? `Added: ${added.map((m) => m.label).join(", ")}` : "Nothing new to add.")
    return
  }
  if (opt("--remove")) {
    rmSync(join(MODELS_DIR, `${opt("--remove")}.json`), { force: true })
    return console.log(`Removed ${opt("--remove")}`)
  }
  if (opt("--import") || opt("--import-file")) {
    let graph, pid
    if (opt("--import")) {
      pid = opt("--import")
      const h = await comfyGet(`/history/${pid}`)
      graph = h[pid]?.prompt?.[2]
      if (!graph) throw new Error(`Run ${pid} isn't in ComfyUI's history`)
    } else {
      const raw = JSON.parse(readFileSync(opt("--import-file"), "utf8"))
      graph = raw.prompt && typeof raw.prompt === "object" && !Array.isArray(raw.prompt) ? raw.prompt : raw
      if (graph.nodes && graph.links) throw new Error("That's the UI-format workflow. In ComfyUI use Workflow → Export (API) instead.")
    }
    if (needsImage(graph)) console.log("Warning: this workflow loads an image/video input; the site only sends text prompts.")
    const id = opt("--as")
    const m = id === "h3" ? buildH3(graph, pid || "file") : buildModel({ graph, sourcePromptId: pid, idOverride: id, labelOverride: opt("--label") })
    if (opt("--label")) m.label = opt("--label")
    saveModel(MODELS_DIR, m)
    console.log(`Saved model "${m.label}" (${m.id}). prompt→${m.fields.prompt.join(".")}, seed→${m.fields.seeds.map((x) => x.join(".")).join(", ")}`)
    console.log("Restart the worker (or wait for its next check-in) and it will appear on the website.")
    return
  }
  return main()
}

cli().catch((e) => {
  console.error("✗ " + e.message)
  process.exit(1)
})
