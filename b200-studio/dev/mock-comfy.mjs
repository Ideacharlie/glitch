// Fake ComfyUI used only for local testing (the real B200 is on the VPN).
// Mimics the endpoints the worker uses. "Generation" takes MOCK_SECS seconds and returns dev/sample.mp4.
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8188)
const SECS = Number(process.env.MOCK_SECS || 6)
const TEMPLATE_ID = "3bfe3a21-e6e1-4aba-9efe-a0b20b6a4f67"

// Shape mirrors the notes about the real graph: only the node ids/inputs the worker touches matter.
const template = {
  "105:104": { class_type: "CLIPTextEncode", inputs: { prompt: "a test", clip: ["105:2", 0] } },
  "105:111": { class_type: "PrimitiveInt", inputs: { value: 5 } },
  "105:15": { class_type: "RandomNoise", inputs: { noise_seed: 42 } },
  "105:110": { class_type: "PrimitiveInt", inputs: { value: 864 } },
  "105:112": { class_type: "PrimitiveInt", inputs: { value: 480 } },
  "105:2": { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors" } },
}
// Fake past runs, the way the real ComfyUI history looks: a Wan text-to-video run, an LTX run,
// a Wan image-to-video run (should be skipped) and an H3 turbo run (should be ignored).
const wan = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors", weight_dtype: "default" } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan" } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "a red kite over a beach", clip: ["2", 0] } },
  "4": { class_type: "CLIPTextEncode", inputs: { text: "blurry, low quality, watermark", clip: ["2", 0] } },
  "5": { class_type: "EmptyHunyuanLatentVideo", inputs: { width: 1280, height: 704, length: 81, batch_size: 1 } },
  "6": { class_type: "KSamplerAdvanced", inputs: { model: ["1", 0], positive: ["3", 0], negative: ["4", 0], latent_image: ["5", 0], noise_seed: 1234, steps: 20, cfg: 3.5 } },
  "7": { class_type: "KSamplerAdvanced", inputs: { model: ["1", 0], positive: ["3", 0], negative: ["4", 0], latent_image: ["6", 0], noise_seed: 0, steps: 20, cfg: 3.5 } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["9", 0] } },
  "9": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
  "10": { class_type: "SaveVideo", inputs: { video: ["8", 0], filename_prefix: "video/wan" } },
}
const ltx = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "ltxv-13b-0.9.8-distilled.safetensors" } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "t5xxl_fp16.safetensors", type: "ltxv" } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "waves crashing in slow motion", clip: ["2", 0] } },
  "4": { class_type: "CLIPTextEncode", inputs: { text: "worst quality", clip: ["2", 0] } },
  "5": { class_type: "LTXVConditioning", inputs: { positive: ["3", 0], negative: ["4", 0], frame_rate: 24 } },
  "6": { class_type: "EmptyLTXVLatentVideo", inputs: { width: 768, height: 512, length: 97, batch_size: 1 } },
  "7": { class_type: "RandomNoise", inputs: { noise_seed: 77 } },
  "8": { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: ["5", 0], negative: ["5", 1], cfg: 3 } },
  "9": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["7", 0], guider: ["8", 0], latent_image: ["6", 0] } },
  "10": { class_type: "SaveVideo", inputs: { video: ["9", 0], filename_prefix: "video/ltx" } },
}
const wanI2V = { ...structuredClone(wan), "11": { class_type: "LoadImage", inputs: { image: "start.png" } } }
const h3turbo = { ...structuredClone(template), "105:2": { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_t2v_turbo.safetensors" } } }
const okOut = { "x": { images: [{ filename: "old_00001_.mp4", subfolder: "video", type: "output" }] } }
const entry = (n, id, g) => ({ prompt: [n, id, g, {}, []], outputs: okOut, status: { completed: true, status_str: "success" } })
const history = {
  [TEMPLATE_ID]: entry(1, TEMPLATE_ID, template),
  "wan-old-run": entry(2, "wan-old-run", wan),
  "ltx-run": entry(3, "ltx-run", ltx),
  "wan-i2v-run": entry(4, "wan-i2v-run", wanI2V),
  "h3-turbo-run": entry(5, "h3-turbo-run", h3turbo),
  "wan-new-run": entry(6, "wan-new-run", wan),
}
const familyOf = (g) => JSON.stringify(g).match(/wan2|ltxv|minimax/i)?.[0].toLowerCase() || "?"
const SECS_BY = { wan2: SECS * 1.5, ltxv: SECS * 0.6, minimax: SECS }
const queue = [] // {id, graph, startedAt?}
const received = []

setInterval(() => {
  const cur = queue[0]
  if (!cur) return
  if (!cur.startedAt) cur.startedAt = Date.now()
  if (Date.now() - cur.startedAt > (SECS_BY[familyOf(cur.graph)] || SECS) * 1000) {
    queue.shift()
    const fail = JSON.stringify(cur.graph).includes("FAILME")
    history[cur.id] = fail
      ? { prompt: [0, cur.id, cur.graph], outputs: {}, status: { status_str: "error", completed: false, messages: [["execution_error", { exception_message: "CUDA out of memory (mock)" }]] } }
      : { prompt: [0, cur.id, cur.graph], outputs: { "105:200": { images: [{ filename: "H3_00001_.mp4", subfolder: "video", type: "output" }], animated: [true] } }, status: { status_str: "success", completed: true } }
  }
}, 250)

createServer((req, res) => {
  const url = new URL(req.url, "http://x")
  const send = (code, obj, type = "application/json") => {
    res.writeHead(code, { "content-type": type })
    res.end(type === "application/json" ? JSON.stringify(obj) : obj)
  }
  if (url.pathname === "/system_stats") return send(200, { devices: [{ name: "cuda:0 NVIDIA B200 (mock)", vram_total: 183 * 2 ** 30 }] })
  if (url.pathname === "/queue" && req.method === "GET")
    return send(200, {
      queue_running: queue.filter((q) => q.startedAt).map((q, i) => [i, q.id]),
      queue_pending: queue.filter((q) => !q.startedAt).map((q, i) => [i, q.id]),
    })
  if (url.pathname === "/history") return send(200, history)
  if (url.pathname.startsWith("/history/")) {
    const id = url.pathname.split("/")[2]
    return send(200, history[id] ? { [id]: history[id] } : {})
  }
  if (url.pathname === "/view") return send(200, readFileSync(join(HERE, "sample.mp4")), "video/mp4")
  if (req.method === "POST") {
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      const b = JSON.parse(body || "{}")
      if (url.pathname === "/prompt") {
        const id = crypto.randomUUID()
        queue.push({ id, graph: b.prompt })
        received.push(b.prompt)
        const texts = Object.entries(b.prompt).filter(([, n]) => typeof (n.inputs.text ?? n.inputs.prompt) === "string").map(([k, n]) => `${k}=${JSON.stringify(n.inputs.text ?? n.inputs.prompt).slice(0, 50)}`)
        const seeds = Object.entries(b.prompt).filter(([, n]) => typeof (n.inputs.noise_seed ?? n.inputs.seed) === "number").map(([k, n]) => `${k}=${n.inputs.noise_seed ?? n.inputs.seed}`)
        const sizes = Object.entries(b.prompt).filter(([, n]) => "width" in n.inputs).map(([k, n]) => `${k}=${n.inputs.width}x${n.inputs.height}`)
        console.log(`mock: got ${familyOf(b.prompt)} prompt ${id} | text ${texts.join(" ")} | seeds ${seeds.join(" ")} | size ${sizes.join(" ") || "-"} | 105:111=${b.prompt["105:111"]?.inputs.value ?? "-"}`)
        return send(200, { prompt_id: id, number: received.length, node_errors: {} })
      }
      if (url.pathname === "/queue") {
        for (const d of b.delete || []) { const i = queue.findIndex((q) => q.id === d && !q.startedAt); if (i >= 0) queue.splice(i, 1) }
        return send(200, {})
      }
      send(404, {})
    })
    return
  }
  send(404, { error: "not found" })
}).listen(PORT, () => console.log(`mock ComfyUI on :${PORT} (${SECS}s per clip)`))
