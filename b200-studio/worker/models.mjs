// Model templates for the worker.
//
// Every model is a ComfyUI API graph lifted from a run that already worked on the B200. A job only changes
// the prompt and the seed (plus any fixed overrides listed in `fields.set`); every loader, size and
// connection stays exactly as it was in the known-good run.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"

export const FAMILIES = [
  // H3 is never auto-discovered: only the hand-checked run in config.templateHistoryId is trusted
  // (other H3 runs on the box used variants whose LoRAs aren't installed).
  { id: "h3", label: "MiniMax H3", match: /minimax|(^|[^a-z])h3([^a-z]|$)/i, defaultSecs: 125, note: "10 s · with sound", discover: false },
  { id: "wan", label: "Wan", match: /(^|[^a-z])wan/i, defaultSecs: 300, note: "" },
  { id: "ltx", label: "LTX", match: /ltx/i, defaultSecs: 90, note: "" },
  { id: "hunyuan", label: "HunyuanVideo", match: /hunyuan/i, defaultSecs: 300, note: "" },
  { id: "mochi", label: "Mochi", match: /mochi/i, defaultSecs: 300, note: "" },
  { id: "cogvideo", label: "CogVideoX", match: /cogvideo/i, defaultSecs: 240, note: "" },
]

const MODEL_FILE = /\.(safetensors|gguf|ckpt|pt|pth|bin)$/i
const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number"

export function modelFiles(graph) {
  const files = []
  for (const node of Object.values(graph))
    for (const v of Object.values(node.inputs || {})) if (typeof v === "string" && MODEL_FILE.test(v)) files.push(v)
  return files
}

/** Which family a graph belongs to, judged by the diffusion-model file names it loads. */
export function classify(graph) {
  const files = modelFiles(graph)
  // Prefer the main diffusion model loaders over text encoders / VAEs (e.g. "umt5" is used by Wan but says nothing).
  const loaderFiles = []
  for (const node of Object.values(graph)) {
    if (!/UNET|Checkpoint|DiffusionModel|ModelLoader|GGUF/i.test(node.class_type || "")) continue
    for (const v of Object.values(node.inputs || {})) if (typeof v === "string" && MODEL_FILE.test(v)) loaderFiles.push(v)
  }
  for (const pool of [loaderFiles, files])
    for (const f of FAMILIES) {
      const hit = pool.find((x) => f.match.test(x))
      if (hit) return { family: f, file: hit }
    }
  return null
}

/** A short version tag from the model file name, e.g. "wan2.2_t2v_14B_fp16" -> "2.2 14B". */
export function versionTag(file) {
  const base = file.split("/").pop().replace(MODEL_FILE, "")
  let ver = ""
  // "wan2.2", "ltx-2", "hunyuanvideo1.5" — a version right after the family name (but not a size like "13b")
  const right = base.match(/(?:wan|ltxv?|ltx-?video|hunyuan(?:video)?)[ _-]?v?(\d+(?:\.\d+)*(?:_\d(?!\d))?)(?![\d.]*b)/i)
  if (right) ver = right[1].replace(/_/g, ".")
  // otherwise a dotted version anywhere, e.g. "ltxv-13b-0.9.8-distilled"
  if (!ver) ver = base.match(/(?:^|[_-])v?(\d+\.\d+(?:\.\d+)?)(?=[_-]|$)/)?.[1] || ""
  const size = base.match(/(?:^|[_-])A?(\d+(?:\.\d+)?b)(?=[_-]|$)/i)
  return [ver, size ? size[1].toUpperCase() : ""].filter(Boolean).join(" ")
}

/** Needs a starting image? We only offer text-to-video. */
export function needsImage(graph) {
  return Object.values(graph).some((n) => /^LoadImage|LoadVideo|VHS_LoadVideo/i.test(n.class_type || ""))
}

/**
 * Find where the prompt and seed live.
 * Prompt = the text-encode node that feeds a sampler's "positive" input (walking upstream through
 * conditioning nodes), never one that feeds "negative".
 */
export function detectFields(graph) {
  const textKey = (n) => {
    if (!/TextEncode|Prompt|T5|CLIP/i.test(n.class_type || "")) return null
    for (const k of ["text", "prompt", "positive_prompt", "text_g"]) if (typeof n.inputs?.[k] === "string") return k
    return null
  }
  const upstreamText = (startIds) => {
    const seen = new Set()
    const queue = [...startIds]
    while (queue.length) {
      const id = queue.shift()
      if (seen.has(id) || !graph[id]) continue
      seen.add(id)
      const k = textKey(graph[id])
      if (k) return [id, k]
      for (const [key, v] of Object.entries(graph[id].inputs || {})) if (isLink(v) && key !== "negative") queue.push(v[0])
    }
    return null
  }
  const positives = []
  for (const n of Object.values(graph)) {
    const v = n.inputs?.positive
    if (isLink(v)) positives.push(v[0])
  }
  let prompt = upstreamText(positives)
  if (!prompt) {
    const all = Object.entries(graph).map(([id, n]) => [id, textKey(n)]).filter(([, k]) => k)
    if (all.length === 1) prompt = all[0]
  }
  const seeds = []
  for (const [id, n] of Object.entries(graph))
    for (const k of ["noise_seed", "seed"]) if (typeof n.inputs?.[k] === "number") seeds.push([id, k])
  if (!prompt) throw new Error("couldn't find the prompt node in this workflow")
  return { prompt, seeds, set: [] }
}

export function buildModel({ graph, sourcePromptId, idOverride, labelOverride, source }) {
  const c = classify(graph)
  const fam = c?.family
  const id = idOverride || fam?.id
  if (!id) throw new Error("couldn't tell which model this workflow uses; pass --as <id>")
  const famInfo = FAMILIES.find((f) => f.id === id) || fam
  const tag = c ? versionTag(c.file) : ""
  return {
    id,
    label: labelOverride || [famInfo?.label || id, tag].filter(Boolean).join(" "),
    note: famInfo?.note || "",
    modelFile: c?.file || null,
    source: source || (sourcePromptId ? `ComfyUI run ${sourcePromptId}` : "imported file"),
    createdAt: new Date().toISOString(),
    avgSecs: famInfo?.defaultSecs || 240,
    fields: detectFields(graph),
    graph,
  }
}

/** The hand-checked H3 setup from the Aug 2026 notes. */
export function buildH3(graph, sourcePromptId) {
  const need = ["105:104", "105:111", "105:15"]
  for (const id of need) if (!graph[id]) throw new Error(`H3 template is missing node ${id}`)
  return {
    id: "h3",
    label: "MiniMax H3",
    note: "10 s · with sound",
    modelFile: classify(graph)?.file || null,
    source: `ComfyUI run ${sourcePromptId}`,
    createdAt: new Date().toISOString(),
    avgSecs: 125,
    fields: { prompt: ["105:104", "prompt"], seeds: [["105:15", "noise_seed"]], set: [["105:111", "value", 10]] },
    graph,
  }
}

export function applyJob(model, job) {
  const g = structuredClone(model.graph)
  const [pid, pk] = model.fields.prompt
  g[pid].inputs[pk] = job.prompt
  for (const [id, k] of model.fields.seeds) g[id].inputs[k] = job.seed
  for (const [id, k, v] of model.fields.set || []) g[id].inputs[k] = v
  return g
}

export function loadModels(dir) {
  mkdirSync(dir, { recursive: true })
  const out = new Map()
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    try {
      const m = JSON.parse(readFileSync(join(dir, f), "utf8"))
      if (m.id && m.graph && m.fields) out.set(m.id, m)
    } catch {}
  }
  return out
}

export function saveModel(dir, m) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${m.id}.json`), JSON.stringify(m, null, 2))
}

export const hasModel = (dir, id) => existsSync(join(dir, `${id}.json`))
