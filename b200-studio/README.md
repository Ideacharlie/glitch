# B200 Studio

A small website that lets people **off the VPN** queue up AI video prompts and download the results,
using the B200's ComfyUI. People pick a model (MiniMax H3, Wan, LTX, …), type a prompt, and the clip shows up
in the page when it's done.

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
  site for the next prompt, runs it on ComfyUI using a workflow copied from a run that already worked (only
  the prompt and seed change), then uploads the clip. It makes no incoming connections, so nothing on the
  Mac is exposed.
- One clip runs at a time. The site shows each model's typical time, learned from real runs.

## Friend's side

Open the link → enter the passcode → pick a model → type a prompt → **Generate**.
The page shows the queue position, an estimated wait and progress; finished clips play inline with
**Download**, **Remix** (same prompt, new seed) and **Edit**. Failed clips have **Retry**. Each person can have
up to 3 clips waiting at once. Optional browser notification when a clip is ready.

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

## Models

Each model is a ComfyUI workflow copied from a run that **already worked** on the B200 and saved in
`worker/models/<id>.json`. A job only changes the prompt (the text node feeding the sampler's *positive*
input) and the seed; loaders, size, length and every connection stay as they were. The website offers
whichever models the worker has.

- **MiniMax H3** comes from the hand-checked run `3bfe3a21-…` (config `templateHistoryId`), with the
  duration fixed at 10 s. Other H3 runs are never auto-picked (some use variants whose LoRAs aren't installed).
- **Wan, LTX, HunyuanVideo, Mochi, CogVideoX** are found automatically: at start-up and every 30 minutes
  the worker looks through ComfyUI's history for the newest successful text-to-video run of each
  (runs that need a starting image are skipped). So to add Wan or LTX, run it once in ComfyUI.

```bash
node worker.mjs --list                      # what the site is offering
node worker.mjs --discover                  # show candidate runs and add new models now
node worker.mjs --import <prompt_id> --as wan --label "Wan 2.2"   # use a specific run
node worker.mjs --import-file workflow_api.json --as ltx           # or an exported API-format workflow
node worker.mjs --remove wan
```

ComfyUI forgets its history when it restarts, so the copied workflows are kept in `worker/models/`
and keep working. If the H3 run is gone before it was ever copied, export a working H3 run in API format
and import it with `--import-file … --as h3`.

## Status the site shows

- **Online**: worker connected and GPU reachable.
- **Generator paused**: the Mac is on but can't reach ComfyUI (usually the VPN is off) or has no models. Prompts wait.
- **Generator offline**: the worker hasn't checked in for 2+ minutes (Mac asleep/off). Prompts wait.

## Development

`dev/mock-comfy.mjs` is a fake ComfyUI for testing without the VPN
(`ffmpeg … dev/sample.mp4` for a test clip; see the file). Run the site locally with `netlify dev`
using a `.env` containing `STUDIO_PASSCODE` and `WORKER_TOKEN`.
Deploy: `netlify deploy --prod` from this folder (site `b200-studio`).
