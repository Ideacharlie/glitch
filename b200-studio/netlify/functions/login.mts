import type { Config, Context } from "@netlify/functions"
import { COOKIE, isAuthed, json, safeEqual, sessionToken } from "../lib/common.mts"

export default async (req: Request, context: Context) => {
  if (req.method === "GET") return json({ authed: await isAuthed(context) })

  if (req.method === "DELETE") {
    context.cookies.delete({ name: COOKIE, path: "/" })
    return json({ ok: true })
  }

  let body: { passcode?: string } = {}
  try {
    body = await req.json()
  } catch {}
  const want = Netlify.env.get("STUDIO_PASSCODE") || ""
  const got = String(body.passcode || "").trim().toLowerCase()
  if (!want || !safeEqual(got, want.toLowerCase())) {
    await new Promise((r) => setTimeout(r, 800)) // slow down guessing
    return json({ error: "Wrong passcode" }, 401)
  }
  context.cookies.set({
    name: COOKIE,
    value: await sessionToken(),
    path: "/",
    httpOnly: true,
    secure: new URL(req.url).protocol === "https:",
    sameSite: "Lax",
    expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 180),
  })
  return json({ ok: true })
}

export const config: Config = { path: "/api/login", method: ["GET", "POST", "DELETE"] }
