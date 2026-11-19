#!/usr/bin/env bash
# Render entrypoint for the devnet agent stack (see render.yaml, service delphi-stack): facilitator, forecaster,
# resolver, two settlement signers and the buyer, the same processes as run-devnet.sh minus the indexer and dashboard,
# which run as their own Render service and on Vercel.
#   /etc/secrets/delphi-bundle.b64  base64 tar.gz from the operator's machine: .env, keys/, delphi/ (~/.config/delphi
#                                   keys) and optionally data/*-devnet.sqlite*, which seed the state on first boot only.
#   data/                           persistent disk mount; state lives in data/stack/ because the services chmod their
#                                   state directory to 0700 and the mount point itself belongs to root.
# The forecaster is the only public listener (Render's $PORT); everything else stays on loopback.
# Any process exiting stops the whole stack so Render restarts it as a unit.
set -euo pipefail
cd "$(dirname "$0")/.."
bundle=/etc/secrets/delphi-bundle.b64
[ -s "$bundle" ] || { echo "run-render: add the secret file delphi-bundle.b64 to this service (Environment > Secret Files)" >&2; exit 1; }
: "${RENDER_EXTERNAL_URL:?run-render: Render did not provide RENDER_EXTERNAL_URL}" "${PORT:?}"
: "${TELEMETRY_INDEXER_URL:?}" "${TELEMETRY_INDEXER_SECRET:?}"

stage=$(mktemp -d)
base64 -d "$bundle" | tar -xz -C "$stage"
cfg="$HOME/.config/delphi"
mkdir -p "$cfg"
cp "$stage/.env" .env
cp -R "$stage/keys" .
cp -R "$stage/delphi/." "$cfg/"
store=data/stack
if [ ! -d "$store" ]; then
  mkdir -p "$store"
  # Boots before data/stack existed wrote state at the disk root; that is newer than the bundle's seed.
  if compgen -G 'data/*-devnet.sqlite' >/dev/null; then
    mv data/*-devnet.sqlite* "$store/"
    [ ! -d data/attestations-devnet ] || mv data/attestations-devnet "$store/"
  elif [ -d "$stage/data" ]; then
    cp -R "$stage/data/." "$store/"
  fi
  rm -f data/.seeded
fi
rm -rf "$stage"
chmod -R go-rwx .env keys "$cfg"
for f in "$cfg/facilitator.json" "$cfg/channel-authorizer.json" "$cfg/signers/signer-1.json" "$cfg/signers/signer-2.json"; do
  [ -f "$f" ] || { echo "run-render: bundle is missing ${f#"$cfg/"}" >&2; exit 1; }
done

dotenv() {
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" .env | tail -1 | tr -d '\r' |
    sed -E "s/[[:space:]]+\$//; s/^\"(.*)\"\$/\1/; s/^'(.*)'\$/\1/" || true
}
read_rpc=$(dotenv SOLANA_READ_RPC_URL)
reader() { if [ -n "$read_rpc" ]; then env SOLANA_RPC_URL="$read_rpc" "$@"; else "$@"; fi; }
public=${RENDER_EXTERNAL_URL%/}
export FORECASTER_DB="$store/forecaster-devnet.sqlite" SETTLEMENT_ATTESTATIONS_DIR="$store/attestations-devnet"

# Render stops the service with SIGTERM: forward it to every process so SQLite and in-flight work shut down cleanly.
cleanup() { trap '' TERM INT; kill -TERM 0 2>/dev/null || true; wait || true; }
trap cleanup EXIT
trap 'exit 143' TERM INT
start() { # name command...
  local name=$1; shift
  ("$@" 2>&1 | grep --line-buffered -v 'Retrying after\|ws error' | sed -u "s/^/[$name] /") &
  echo "run-render: started $name"
}
wait_port() { for _ in $(seq 1 90); do (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return; sleep 1; done; echo "run-render: port $1 did not open" >&2; exit 1; }

start facilitator reader env FACILITATOR_KEYPAIR="$cfg/facilitator.json" FACILITATOR_DB="$store/facilitator-devnet.sqlite" npm run -s facilitator
wait_port 4050
start forecaster env FORECASTER_URL="$public" FORECASTER_HOST=0.0.0.0 FORECASTER_PORT="$PORT" X402_FACILITATOR_URL=http://127.0.0.1:4050 \
  FORECASTER_CHANNEL_AUTHORIZER_KEYPAIR="$cfg/channel-authorizer.json" FORECAST_BOND_MICRO_USDC="${FORECAST_BOND_MICRO_USDC:-20000}" \
  FORECASTER_MARKET_LIMIT="${FORECASTER_MARKET_LIMIT:-6}" npm run -s forecaster
start resolver npm run -s resolver
wait_port 4040
for i in 1 2; do start "signer-$i" reader npm run -s attest -- --keypair "$cfg/signers/signer-$i.json" --post http://127.0.0.1:4040 --watch --interval "${ATTEST_INTERVAL:-60}"; done
# The buyer only pays URLs on FORECASTER_URL's origin, so it uses the same public URL the listings carry.
start buyer env FORECASTER_URL="$public" BUYER_DB="$store/buyer-devnet.sqlite" BUYER_DRY_RUN="${BUYER_DRY_RUN:-true}" \
  BUYER_PAYMENT_SCHEME="${BUYER_PAYMENT_SCHEME:-exact}" INDEXER_URL="$TELEMETRY_INDEXER_URL" STREAMS_WEBHOOK_SECRET="$TELEMETRY_INDEXER_SECRET" npm run -s buyer
echo "run-render: running at $public"
wait -n
echo "run-render: a service exited; stopping the stack so Render restarts it" >&2
exit 1
