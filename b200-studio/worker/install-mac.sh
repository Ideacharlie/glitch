#!/bin/bash
# Installs the B200 Studio worker on this Mac so it runs in the background, starts at login,
# restarts if it crashes, and keeps the Mac awake while it runs.
#
#   ./install-mac.sh --token <WORKER_TOKEN> --comfy <https://your-comfyui-host> [--site https://b200-studio.netlify.app]
#   ./install-mac.sh --uninstall
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
LABEL="com.b200studio.worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/b200-studio-worker.log"

TOKEN="" COMFY="" SITE="https://b200-studio.netlify.app" TEMPLATE_ID="3bfe3a21-e6e1-4aba-9efe-a0b20b6a4f67"
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --comfy) COMFY="$2"; shift 2 ;;
    --site) SITE="$2"; shift 2 ;;
    --template-id) TEMPLATE_ID="$2"; shift 2 ;;
    --uninstall)
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
      rm -f "$PLIST"; echo "Worker removed."; exit 0 ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
done

NODE="$(command -v node || /bin/zsh -lc 'command -v node' 2>/dev/null || true)"
if [ -z "$NODE" ]; then echo "Node.js is needed first:  brew install node"; exit 1; fi
echo "Using node: $NODE ($("$NODE" -v))"

if [ ! -f config.json ]; then
  [ -n "$TOKEN" ] || { echo "Pass --token <WORKER_TOKEN>"; exit 1; }
  [ -n "$COMFY" ] || { echo "Pass --comfy <ComfyUI URL>"; exit 1; }
  cat > config.json <<EOF
{
  "studioUrl": "$SITE",
  "workerToken": "$TOKEN",
  "comfyUrl": "$COMFY",
  "templateHistoryId": "$TEMPLATE_ID",
  "pollSeconds": 30
}
EOF
  chmod 600 config.json
  echo "Wrote config.json"
fi

echo; echo "Checking the setup…"
if "$NODE" worker.mjs --check; then CHECK=ok; else CHECK=fail; fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-is</string>
    <string>$NODE</string><string>$DIR/worker.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo
echo "Worker installed and running in the background (starts at login, keeps the Mac awake)."
echo "  Log:        tail -f \"$LOG\""
echo "  Uninstall:  $DIR/install-mac.sh --uninstall"
if [ "$CHECK" = fail ]; then
  echo
  echo "Note: the check above had a ✗. The worker is running anyway and will start taking"
  echo "prompts as soon as that is fixed (e.g. once the VPN is connected)."
fi
