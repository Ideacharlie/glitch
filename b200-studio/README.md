# B200 Studio

A small website that lets people **off the VPN** queue up AI video prompts and download the results,
using the B200's ComfyUI (MiniMax H3, 10-second clips with sound).

Live site: **https://b200-studio.netlify.app** (passcode protected)

## How it works

```
friend's browser ──HTTPS──▶ Netlify site (page + small API + storage)
                                  ▲
                                  │ outgoing only: "any new prompts?" / upload finished clip
                                  │
                       Mac Mini worker (worker/worker.mjs) ──VPN──▶ B200 ComfyUI
```

- The **website** keeps a queue of prompts and the finished clips (Netlify Functions + Netlify Blobs).
  Nobody visiting it ever talks to the B200 directly, and the B200 address is never sent to the site.
- The **worker** runs on the Mac Mini, which is on the Research Warrant VPN. Every 30 seconds it asks the
  site for the next prompt, runs it on ComfyUI using the known-good H3 workflow (only the prompt, seed,
  duration and size are changed), then uploads the clip. It makes no incoming connections, so nothing on
  the Mac is exposed.
- One clip runs at a time. Vertical 832×1504 takes ~12 min; landscape 864×480 takes ~2 min.

## Friend's side

Open the link → enter the passcode → type a prompt → pick Vertical or Landscape → **Generate**.
The page shows the queue position, an estimated wait, a progress bar, then **Watch** and **Download**.
Each person can have up to 3 clips waiting at once.

## Mac Mini setup (one time)

Needs Node.js (`brew install node`) and the VPN.

```bash
git clone -b claude/charming-davinci-ymdng2 https://github.com/Ideacharlie/glitch.git ~/b200-studio-src
cd ~/b200-studio-src/b200-studio/worker
./install-mac.sh --token <WORKER_TOKEN> --comfy <https://ComfyUI host>
```

The installer writes `config.json`, runs a self-check (GPU reachable, workflow template loads, website
accepts the token), and installs a background service that starts at login, restarts if it crashes and
keeps the Mac awake (`caffeinate`). Log: `~/Library/Logs/b200-studio-worker.log`.
Remove it with `./install-mac.sh --uninstall`.

`WORKER_TOKEN` and `STUDIO_PASSCODE` are environment variables on the Netlify site
(Site configuration → Environment variables). Changing the passcode signs everyone out; redeploy after
changing either.

### If the workflow template can't be loaded

The worker copies the workflow from ComfyUI run `3bfe3a21-…` the first time and saves it as
`worker/template.json`. ComfyUI forgets its history when it restarts, so if that run is gone, export a
working MiniMax H3 run in **API format** and save it as `worker/template.json`. It needs nodes
`105:104` (prompt), `105:111` (duration), `105:15` (seed), `105:110`/`105:112` (width/height) — run
`node worker.mjs --check` to confirm.

## Status the site shows

- **Online · NVIDIA B200**: worker connected and GPU reachable.
- **GPU unreachable**: the Mac is on but can't reach ComfyUI (usually the VPN is off). Prompts wait.
- **Generator offline**: the worker hasn't checked in for 2+ minutes (Mac asleep/off). Prompts wait.

## Development

`dev/mock-comfy.mjs` is a fake ComfyUI for testing without the VPN
(`ffmpeg … dev/sample.mp4` for a test clip; see the file). Run the site locally with `netlify dev`
using a `.env` containing `STUDIO_PASSCODE` and `WORKER_TOKEN`.
Deploy: `netlify deploy --prod` from this folder (site `b200-studio`).
