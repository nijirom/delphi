#!/usr/bin/env bash
# Run the whole devnet stack: facilitator, indexer, forecaster, resolver, settlement signers, buyer, dashboard.
# Reads SOLANA_RPC_URL and friends from .env. Logs go to data/logs/<service>.log. Ctrl-C stops everything.
#   PUBLIC_HOST=tailscale (or the exact <machine>.<tailnet>.ts.net) serves through Tailscale Funnel (stable): dashboard :443, forecaster :8443, resolver :10000.
#   DEVNET_PUBLIC=1  instead opens throwaway Cloudflare quick tunnels (URLs change every run).
#   BUYER_DRY_RUN=false  lets the buyer pay for reads (it never trades without Gemini credentials).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/logs
cfg="$HOME/.config/delphi"
for f in "$cfg/facilitator.json" "$cfg/channel-authorizer.json" "$cfg/signers/signer-1.json" "$cfg/signers/signer-2.json"; do
  [ -f "$f" ] || { echo "run-devnet: missing $f" >&2; exit 1; }
done
# Shell overrides from earlier localnet sessions must not leak into a devnet run.
# Optional second endpoint for read-heavy services, so they don't share a free-tier rate limit with payments.
read_rpc=$(grep -E '^SOLANA_READ_RPC_URL=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)
unset SOLANA_RPC_URL USDC_MINT FORECASTER_URL DELPHI_PROGRAM_ID INDEXER_URL
reader() { if [ -n "$read_rpc" ]; then env SOLANA_RPC_URL="$read_rpc" "$@"; else "$@"; fi; }
# Cadences keep eight processes under a free-tier RPC limit (QuickNode free: 15 req/s); raise them on paid plans.
export INDEXER_POLL_MS=${INDEXER_POLL_MS:-30000} INDEXER_SOURCE=rpc INDEXER_DB=./data/indexer-devnet.sqlite FORECASTER_DB=data/forecaster-devnet.sqlite \
  SETTLEMENT_ATTESTATIONS_DIR=data/attestations-devnet \
  INDEXER_URL=http://127.0.0.1:4030
pids=()
cleanup() { [ ${#pids[@]} -eq 0 ] || kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
start() { # name command...
  local name=$1; shift
  ("$@" 2>&1 | grep --line-buffered -v 'Retrying after\|ws error' >"data/logs/$name.log") &
  pids+=($!)
  echo "run-devnet: $name -> data/logs/$name.log"
}
wait_port() { for _ in $(seq 1 90); do curl -s -o /dev/null "http://127.0.0.1:$1/" && return; sleep 1; done; echo "run-devnet: port $1 did not open" >&2; exit 1; }

forecaster_url=http://127.0.0.1:4020
public=0
if [ -n "${PUBLIC_HOST:-}" ]; then
  ts_sock="$cfg/tailscale/tailscaled.sock"
  ts() { tailscale --socket="$ts_sock" "$@"; }
  if ! ts status >/dev/null 2>&1; then
    start tailscaled tailscaled --tun=userspace-networking --statedir="$cfg/tailscale" --socket="$ts_sock" --port=0
    for _ in $(seq 1 30); do ts status >/dev/null 2>&1 && break; sleep 1; done
  fi
  ts_state=$(ts status --json)
  ts_name=$(jq -r '.Self.DNSName // ""' <<<"$ts_state"); ts_name=${ts_name%.}
  # PUBLIC_HOST=tailscale follows whatever name the machine has in the tailnet (it can be renamed in the admin console).
  [ "$PUBLIC_HOST" = tailscale ] && PUBLIC_HOST=$ts_name
  [ -n "$ts_name" ] && [ "$ts_name" = "$PUBLIC_HOST" ] || { echo "run-devnet: this machine is '$ts_name' on Tailscale, not '$PUBLIC_HOST'" >&2; exit 1; }
  # Funnel config persists in tailscaled state; reapplying is idempotent.
  ts funnel --bg --https=443 http://127.0.0.1:4173 >/dev/null
  ts funnel --bg --https=8443 http://127.0.0.1:4020 >/dev/null
  ts funnel --bg --https=10000 http://127.0.0.1:4040 >/dev/null
  npm run -s build >/dev/null
  start web env WEB_PREVIEW_PORT=4173 WEB_ALLOWED_HOSTS="$PUBLIC_HOST" npx vite preview --config apps/web/vite.config.ts
  forecaster_url="https://$PUBLIC_HOST:8443"
  printf 'FORECASTER_URL=%s\nRESOLVER_PUBLIC_URL=%s\nDASHBOARD_URL=%s\nSTREAMS_WEBHOOK_URL=%s\n' "$forecaster_url" "https://$PUBLIC_HOST:10000" "https://$PUBLIC_HOST" "https://$PUBLIC_HOST/api/webhooks/streams" > data/public-urls.env
  public=1
elif [ "${DEVNET_PUBLIC:-0}" = 1 ]; then
  rm -f data/public-urls.env
  start expose npm run -s expose
  for _ in $(seq 1 180); do [ -s data/public-urls.env ] && break; sleep 1; done
  [ -s data/public-urls.env ] || { echo "run-devnet: tunnels did not come up; see data/logs/expose.log" >&2; exit 1; }
  forecaster_url=$(grep '^FORECASTER_URL=' data/public-urls.env | cut -d= -f2-)
  public=1
fi

# The facilitator settles bursts of payments each scan; on the second endpoint it doesn't compete with forecaster/resolver/buyer.
start facilitator reader env FACILITATOR_KEYPAIR="$cfg/facilitator.json" FACILITATOR_DB=data/facilitator-devnet.sqlite npm run -s facilitator
wait_port 4050
start indexer reader npm run -s indexer
start forecaster env FORECASTER_URL="$forecaster_url" X402_FACILITATOR_URL=http://127.0.0.1:4050 \
  FORECASTER_CHANNEL_AUTHORIZER_KEYPAIR="$cfg/channel-authorizer.json" FORECAST_BOND_MICRO_USDC=${FORECAST_BOND_MICRO_USDC:-20000} \
  FORECASTER_MARKET_LIMIT=${FORECASTER_MARKET_LIMIT:-6} npm run -s forecaster
start resolver npm run -s resolver
wait_port 4040
for i in 1 2; do start "signer-$i" reader npm run -s attest -- --keypair "$cfg/signers/signer-$i.json" --post http://127.0.0.1:4040 --watch --interval "${ATTEST_INTERVAL:-60}"; done
# The buyer only pays URLs on FORECASTER_URL's origin, so it must use the same (public) URL the listings carry.
# exact by default: upto bundles escrow USDC until claimed, and a rate-limited RPC can strand those claims.
# Use BUYER_PAYMENT_SCHEME=upto only with RPC headroom (e.g. a paid QuickNode plan).
start buyer env FORECASTER_URL="$forecaster_url" BUYER_DB=./data/buyer-devnet.sqlite BUYER_DRY_RUN=${BUYER_DRY_RUN:-true} BUYER_PAYMENT_SCHEME=${BUYER_PAYMENT_SCHEME:-exact} npm run -s buyer
[ "$public" = 1 ] || start web npm run -s web
[ "$public" = 1 ] && cat data/public-urls.env
echo "run-devnet: running. Ctrl-C stops all services."
wait
