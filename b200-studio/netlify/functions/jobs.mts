import type { Config, Context } from "@netlify/functions"
import {
  ASPECTS,
  type Aspect,
  type Job,
  deleteVideo,
  getJob,
  isAuthed,
  jobKey,
  jobsStore,
  json,
  listJobs,
  newId,
  saveJob,
} from "../lib/common.mts"

const MAX_QUEUED_PER_NAME = 3
const MAX_QUEUED_TOTAL = 20
const SHOW = 40

export default async (req: Request, context: Context) => {
  if (!(await isAuthed(context))) return json({ error: "Not signed in" }, 401)
  const id = context.params.id

  if (req.method === "GET") {
    const all = await listJobs()
    const active = all.filter((j) => j.status === "queued" || j.status === "running")
    // Oldest first = the order the Mac picks them up in.
    const line = active.sort((a, b) => a.createdAt - b.createdAt)
    const position = new Map(line.map((j, i) => [j.id, i]))
    const ahead = (j: Job) => {
      const p = position.get(j.id)
      if (p === undefined) return null
      // Sum of expected time of everything in front of this job.
      return line.slice(0, p).reduce((s, x) => {
        if (x.status === "running" && x.genStartedAt) return s + Math.max(30, x.expectedSecs - (Date.now() - x.genStartedAt) / 1000)
        return s + x.expectedSecs
      }, 0)
    }
    const jobs = all.slice(0, SHOW).map((j) => ({ ...j, position: position.get(j.id) ?? null, waitSecs: ahead(j) }))
    const worker = await jobsStore().get("worker/heartbeat", { type: "json" })
    return json({ jobs, worker, now: Date.now() })
  }

  if (req.method === "POST" && !id) {
    let b: any = {}
    try {
      b = await req.json()
    } catch {}
    const name = String(b.name || "").trim().slice(0, 40)
    const prompt = String(b.prompt || "").trim()
    const aspect = (b.aspect in ASPECTS ? b.aspect : "vertical") as Aspect
    let seed = Number.parseInt(b.seed, 10)
    if (!Number.isFinite(seed) || seed < 0) seed = Math.floor(Math.random() * 2 ** 31)
    seed = Math.min(seed, 2 ** 48)
    if (!name) return json({ error: "Add your name so you can find your clips." }, 400)
    if (prompt.length < 3) return json({ error: "Write a prompt first." }, 400)
    if (prompt.length > 2000) return json({ error: "That prompt is too long (2000 characters max)." }, 400)

    const all = await listJobs()
    const queued = all.filter((j) => j.status === "queued")
    if (queued.length >= MAX_QUEUED_TOTAL) return json({ error: "The queue is full right now. Try again once a few finish." }, 429)
    const mine = queued.filter((j) => j.name.toLowerCase() === name.toLowerCase())
    if (mine.length >= MAX_QUEUED_PER_NAME)
      return json({ error: `You already have ${mine.length} clips waiting. Add more once one starts.` }, 429)

    const job: Job = {
      id: newId(),
      name,
      prompt,
      aspect,
      seed,
      status: "queued",
      createdAt: Date.now(),
      expectedSecs: ASPECTS[aspect].expectedSecs,
    }
    await saveJob(job)
    return json({ job }, 201)
  }

  if (req.method === "DELETE" && id) {
    const job = await getJob(id)
    if (!job) return json({ ok: true })
    if (job.status === "queued") {
      job.status = "cancelled"
      job.finishedAt = Date.now()
      await saveJob(job)
      return json({ job })
    }
    if (job.status === "running") return json({ error: "That clip is already on the GPU and can't be stopped." }, 409)
    await deleteVideo(id)
    await jobsStore().delete(jobKey(id))
    return json({ ok: true, deleted: true })
  }

  return json({ error: "Not found" }, 404)
}

export const config: Config = { path: ["/api/jobs", "/api/jobs/:id"], method: ["GET", "POST", "DELETE"] }
