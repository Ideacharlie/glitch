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
const history = { [TEMPLATE_ID]: { prompt: [0, TEMPLATE_ID, template, {}, []], outputs: {}, status: { completed: true, status_str: "success" } } }
const queue = [] // {id, graph, startedAt?}
const received = []

setInterval(() => {
  const cur = queue[0]
  if (!cur) return
  if (!cur.startedAt) cur.startedAt = Date.now()
  if (Date.now() - cur.startedAt > SECS * 1000) {
    queue.shift()
    const fail = cur.graph["105:104"].inputs.prompt.includes("FAILME")
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
        console.log("mock: got prompt", id, JSON.stringify({
          prompt: b.prompt["105:104"].inputs.prompt, secs: b.prompt["105:111"].inputs.value, seed: b.prompt["105:15"].inputs.noise_seed,
          w: b.prompt["105:110"].inputs.value, h: b.prompt["105:112"].inputs.value,
        }))
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
