import type { Config, Context } from "@netlify/functions"
import { type Job, getJob, isWorker, jobsStore, json, listJobs, saveJob, videosStore } from "../lib/common.mts"

// Endpoints used only by the worker script on the Mac Mini (Bearer WORKER_TOKEN).
//   POST /api/worker/claim            {heartbeat}          -> {job|null}
//   POST /api/worker/update           {id, patch, heartbeat} -> {job, cancelled}
//   PUT  /api/worker/upload/:id/:n    raw bytes (one chunk)
//   POST /api/worker/finish           {id, video}
//   POST /api/worker/fail             {id, error}

const MAX_CHUNK = 4_000_000

async function beat(hb: unknown) {
  if (!hb || typeof hb !== "object") return
  await jobsStore().setJSON("worker/heartbeat", { ...(hb as object), at: Date.now() })
}

export default async (req: Request, context: Context) => {
  if (!isWorker(req)) return json({ error: "Forbidden" }, 403)
  const { action, id, n } = context.params

  if (action === "upload" && req.method === "PUT") {
    const job = await getJob(id)
    if (!job) return json({ error: "No such job" }, 404)
    const buf = await req.arrayBuffer()
    if (buf.byteLength === 0 || buf.byteLength > MAX_CHUNK) return json({ error: "Bad chunk size" }, 400)
    await videosStore().set(`${id}/${Number.parseInt(n, 10)}`, buf)
    return json({ ok: true, bytes: buf.byteLength })
  }

  let b: any = {}
  try {
    b = await req.json()
  } catch {}
  await beat(b.heartbeat)

  if (action === "claim") {
    if (b.heartbeat && b.heartbeat.comfyOk === false) return json({ job: null })
    const all = await listJobs()
    // Resume anything the worker had in flight (e.g. after the Mac restarted), else the oldest queued job.
    const running = all.filter((j) => j.status === "running").sort((a, b) => a.createdAt - b.createdAt)[0]
    if (running) return json({ job: running, resumed: true })
    // Only hand out jobs for models this worker actually has; others wait until it does.
    const have = new Set(((b.heartbeat && b.heartbeat.models) || []).map((m: { id: string }) => m.id))
    const runnable = (j: Job) => have.size === 0 || have.has(j.model || "h3")
    const next = all.filter((j) => j.status === "queued" && runnable(j)).sort((a, b) => a.createdAt - b.createdAt)[0]
    if (!next) return json({ job: null })
    const info = ((b.heartbeat && b.heartbeat.models) || []).find((m: { id: string }) => m.id === (next.model || "h3"))
    if (info?.expectedSecs) next.expectedSecs = info.expectedSecs
    next.status = "running"
    next.startedAt = Date.now()
    next.note = "Sending to the GPU"
    await saveJob(next)
    return json({ job: next })
  }

  if (action === "update") {
    const job = await getJob(b.id)
    if (!job) return json({ error: "No such job" }, 404)
    if (job.status === "cancelled") return json({ job, cancelled: true })
    const p = b.patch || {}
    for (const k of ["note", "comfyPromptId", "genStartedAt"] as const) if (k in p) (job as any)[k] = p[k]
    await saveJob(job)
    return json({ job, cancelled: false })
  }

  if (action === "finish") {
    const job = await getJob(b.id)
    if (!job) return json({ error: "No such job" }, 404)
    const v = b.video || {}
    job.video = {
      chunks: Number(v.chunks),
      size: Number(v.size),
      type: String(v.type || "video/mp4"),
      filename: String(v.filename || `${job.id}.mp4`),
    }
    job.status = "done"
    job.note = undefined
    job.finishedAt = Date.now()
    await saveJob(job)
    return json({ job })
  }

  if (action === "fail") {
    const job = await getJob(b.id)
    if (!job) return json({ error: "No such job" }, 404)
    job.status = "failed"
    job.error = String(b.error || "Something went wrong on the GPU").slice(0, 500)
    job.note = undefined
    job.finishedAt = Date.now()
    await saveJob(job)
    return json({ job })
  }

  return json({ error: "Unknown action" }, 404)
}

export const config: Config = {
  path: ["/api/worker/:action", "/api/worker/:action/:id/:n"],
  method: ["POST", "PUT"],
}
