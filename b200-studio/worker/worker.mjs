#!/usr/bin/env node
// B200 Studio worker — runs on the Mac Mini (which is on the Research Warrant VPN).
// It asks the website for new prompts, runs them on the B200's ComfyUI, and uploads the finished clip.
// Only outgoing connections: nothing on this Mac is exposed to the internet.
//
//   node worker.mjs           run forever
//   node worker.mjs --check   test the setup once and exit
//
// ComfyUI calls go through `curl` on purpose: macOS curl trusts the VPN root CA from the keychain,
// while Node would need extra certificate setup.

import { spawn } from "node:child_process"
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

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

const SIZES = { vertical: [832, 1504], landscape: [864, 480] }
const NODES = { prompt: "105:104", duration: "105:111", seed: "105:15", width: "105:110", height: "105:112" }

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

// ---------- workflow template ----------
let template = null
async function loadTemplate() {
  if (template) return template
  const cache = join(HERE, "template.json")
  if (existsSync(cache)) {
    template = JSON.parse(readFileSync(cache, "utf8"))
  } else {
    const h = await comfyGet(`/history/${TEMPLATE_ID}`)
    const entry = h[TEMPLATE_ID]
    if (!entry) throw new Error(`Template run ${TEMPLATE_ID} not found in ComfyUI history`)
    template = entry.prompt[2]
    writeFileSync(cache, JSON.stringify(template, null, 2))
    log("Saved workflow template to template.json")
  }
  for (const [what, id] of Object.entries(NODES)) if (!template[id]) throw new Error(`Template is missing node ${id} (${what})`)
  return template
}

function setNumber(node, preferred, value) {
  const inputs = node.inputs
  for (const k of [preferred, "value", "int", "number"]) {
    if (k in inputs && typeof inputs[k] !== "object") {
      inputs[k] = value
      return
    }
  }
  throw new Error(`Don't know which input to set on node ${node.class_type}: ${Object.keys(inputs).join(", ")}`)
}

async function buildGraph(job) {
  const g = structuredClone(await loadTemplate())
  const [w, h] = SIZES[job.aspect] || SIZES.vertical
  g[NODES.prompt].inputs.prompt = job.prompt
  setNumber(g[NODES.duration], "value", 10)
  g[NODES.seed].inputs.noise_seed = job.seed
  setNumber(g[NODES.width], "width", w)
  setNumber(g[NODES.height], "height", h)
  return g
}

// ---------- running one job ----------
async function update(job, patch) {
  const r = await studio("/api/worker/update", { body: { id: job.id, patch, heartbeat: { comfyOk: true, ...lastGpu, busy: true } } })
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
  log(`▶ ${job.id} [${job.aspect}] "${job.prompt.slice(0, 60)}" — ${job.name}`)
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
    const r = await comfyPost("/prompt", { prompt: await buildGraph(job), client_id: "b200-studio" })
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
    try {
      const t = await loadTemplate()
      say(true, `Workflow template loaded (${Object.keys(t).length} nodes)`)
      for (const [what, id] of Object.entries(NODES)) console.log(`    ${what.padEnd(8)} ${id} ${t[id].class_type} inputs: ${Object.keys(t[id].inputs).join(", ")}`)
      await buildGraph({ prompt: "test", seed: 1, aspect: "vertical" })
      say(true, "Prompt/size/seed fields can be set")
    } catch (e) {
      say(false, "Workflow template: " + e.message)
    }
  }
  try {
    await studio("/api/worker/update", { body: { id: "check", heartbeat: hb } }).catch((e) => {
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
      if (hb.comfyOk) {
        try {
          await loadTemplate()
        } catch (e) {
          hb = { ...hb, comfyOk: false, comfyError: "Workflow template problem: " + e.message.slice(0, 150) }
        }
      }
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

if (process.argv.includes("--check")) check()
else main()
