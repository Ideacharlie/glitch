import { getStore } from "@netlify/blobs"
import type { Context } from "@netlify/functions"

export const COOKIE = "studio_auth"

export const jobsStore = () => getStore({ name: "studio-jobs", consistency: "strong" })
export const videosStore = () => getStore({ name: "studio-videos", consistency: "strong" })

export interface ModelInfo {
  id: string
  label: string
  note?: string
  expectedSecs: number
}

// Shown before the Mac worker has ever checked in.
export const FALLBACK_MODELS: ModelInfo[] = [{ id: "h3", label: "MiniMax H3", note: "10 s · with sound", expectedSecs: 125 }]

export async function knownModels(): Promise<ModelInfo[]> {
  const hb = (await jobsStore().get("worker/heartbeat", { type: "json" })) as { models?: ModelInfo[] } | null
  return hb?.models?.length ? hb.models : FALLBACK_MODELS
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled"

export interface Job {
  id: string
  name: string
  prompt: string
  model: string
  modelLabel: string
  seed: number
  status: JobStatus
  createdAt: number
  startedAt?: number
  genStartedAt?: number
  finishedAt?: number
  note?: string
  error?: string
  comfyPromptId?: string
  expectedSecs: number
  video?: { chunks: number; size: number; type: string; filename: string }
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })

const enc = new TextEncoder()

async function hmacHex(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

export async function sessionToken() {
  const passcode = Netlify.env.get("STUDIO_PASSCODE")
  if (!passcode) throw new Error("STUDIO_PASSCODE is not set")
  return hmacHex(passcode, "b200-studio-session-v1")
}

export async function isAuthed(context: Context) {
  const c = context.cookies.get(COOKIE)
  if (!c) return false
  return safeEqual(c, await sessionToken())
}

export function isWorker(req: Request) {
  const want = Netlify.env.get("WORKER_TOKEN")
  if (!want) return false
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")
  return safeEqual(got, want)
}

export const jobKey = (id: string) => `job/${id}`

export function newId() {
  const t = Date.now().toString(36).padStart(9, "0")
  const r = crypto.getRandomValues(new Uint8Array(4))
  return t + "-" + [...r].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export async function listJobs(limit = 1000): Promise<Job[]> {
  const store = jobsStore()
  const { blobs } = await store.list({ prefix: "job/" })
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit)
  const jobs = await Promise.all(keys.map((k) => store.get(k, { type: "json" }) as Promise<Job | null>))
  return jobs.filter((j): j is Job => !!j)
}

export async function getJob(id: string) {
  return (await jobsStore().get(jobKey(id), { type: "json" })) as Job | null
}

export async function saveJob(job: Job) {
  await jobsStore().setJSON(jobKey(job.id), job)
}

export async function deleteVideo(id: string) {
  const store = videosStore()
  const { blobs } = await store.list({ prefix: `${id}/` })
  await Promise.all(blobs.map((b) => store.delete(b.key)))
}
