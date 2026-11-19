#!/usr/bin/env bash
# Publish the internet-facing services through Cloudflare quick tunnels (no account needed).
# Exposed: forecaster (listings, x402 reads, /publications), resolver (/attestations), dashboard (built, preview mode).
# Never exposed: the facilitator (it sponsors SOL fees), the indexer write endpoints (reached only via the dashboard proxy).
# Quick-tunnel URLs change on every run; use a named Cloudflare tunnel for a stable launch domain.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v cloudflared >/dev/null || { echo "expose: install cloudflared (brew install cloudflared)" >&2; exit 1; }
dir=$(mktemp -d)
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; rm -rf "$dir"; }
trap cleanup EXIT INT TERM

tunnel() { # name port
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$2" >"$dir/$1.log" 2>&1 &
  pids+=($!)
}
url() { # name
  for _ in $(seq 1 60); do
    u=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$dir/$1.log" | head -1 || true)
    [ -n "$u" ] && { echo "$u"; return; }
    sleep 1
  done
  echo "expose: tunnel $1 did not come up; see $dir/$1.log" >&2; exit 1
}

tunnel forecaster "${FORECASTER_PORT:-4020}"
tunnel resolver "${RESOLVER_PORT:-4040}"
npm run -s build >/dev/null
WEB_PREVIEW_PORT=4173 WEB_ALLOWED_HOSTS=.trycloudflare.com npx vite preview --config apps/web/vite.config.ts >"$dir/web-server.log" 2>&1 &
pids+=($!)
tunnel web 4173

forecaster=$(url forecaster); resolver=$(url resolver); web=$(url web)
mkdir -p data
cat > data/public-urls.env <<EOF
FORECASTER_URL=$forecaster
RESOLVER_PUBLIC_URL=$resolver
DASHBOARD_URL=$web
EOF
cat <<EOF
expose: public endpoints (written to data/public-urls.env)
  dashboard   $web
  forecaster  $forecaster   <- restart the forecaster with FORECASTER_URL=$forecaster so listing and publication URLs match
  resolver    $resolver   <- signers run: npm run attest -- --keypair <key> --post $resolver --watch
Ctrl-C closes all tunnels.
EOF
wait
