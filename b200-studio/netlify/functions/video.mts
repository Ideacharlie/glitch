import type { Config, Context } from "@netlify/functions"
import { isAuthed, json, videosStore } from "../lib/common.mts"

// Videos are stored in chunks of a few MB because a function response is capped at ~4.5 MB.
// The page downloads every chunk and stitches them back together in the browser.
export default async (req: Request, context: Context) => {
  if (!(await isAuthed(context))) return json({ error: "Not signed in" }, 401)
  const { id, n } = context.params
  if (!/^[0-9a-z-]+$/.test(id) || !/^\d+$/.test(n)) return json({ error: "Bad request" }, 400)
  const data = await videosStore().get(`${id}/${n}`, { type: "arrayBuffer" })
  if (data === null) return json({ error: "Not found" }, 404)
  return new Response(data, {
    headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=31536000, immutable" },
  })
}

export const config: Config = { path: "/api/video/:id/:n", method: "GET" }
