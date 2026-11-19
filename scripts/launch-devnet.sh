#!/usr/bin/env bash
# One-shot public devnet launch: deploy (or upgrade) the program, then initialize
# the settlement quorum, bond escrow and personas through setup-devnet.
# Every precondition is checked before anything is spent.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
# Shell values win; otherwise take the committed launch settings from .env (only these keys, never secrets).
for key in SETTLEMENT_SIGNERS SETTLEMENT_THRESHOLD BOND_TREASURY_TOKEN_ACCOUNT; do
  if [ -z "${!key:-}" ] && [ -f .env ]; then value=$(grep -E "^$key=" .env | tail -1 | cut -d= -f2-); [ -n "$value" ] && export "$key=$value"; fi
done

DEVNET_GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
RPC=${SOLANA_RPC_URL:-https://api.devnet.solana.com}
PROGRAM_ID=EVqrBtTWaQiwnrhXzDgqr5TML6oDpHqHs5jjeLLg42Qc
AUTHORITY=keys/oracle.json
SO=programs/delphi/target/deploy/delphi.so
MIN_SOL=6

die() { echo "launch: $*" >&2; exit 1; }

[ "$(solana genesis-hash -u "$RPC")" = "$DEVNET_GENESIS" ] || die "RPC $RPC is not Solana devnet"
[ "$(solana address -k keys/delphi-program.json)" = "$PROGRAM_ID" ] || die "keys/delphi-program.json does not match declare_id!"
[ -n "${SETTLEMENT_SIGNERS:-}" ] || die "set SETTLEMENT_SIGNERS to 2-5 comma-separated signer public keys (keys held by separate operators)"
[ -n "${BOND_TREASURY_TOKEN_ACCOUNT:-}" ] || die "set BOND_TREASURY_TOKEN_ACCOUNT to the devnet USDC token account that receives slashed bonds"
for key in ${SETTLEMENT_SIGNERS//,/ }; do
  for local in keys/*.json; do
    [ "$(solana address -k "$local" 2>/dev/null)" != "$key" ] || die "signer $key has its secret key in $local; a quorum held on one machine is not independent"
  done
done

balance=$(solana balance -k "$AUTHORITY" -u "$RPC" | awk '{print $1}')
awk -v b="$balance" -v m="$MIN_SOL" 'BEGIN { exit !(b >= m) }' || die "$(solana address -k "$AUTHORITY") holds $balance SOL; need >= $MIN_SOL (program rent ~2.7 SOL plus an equal temporary upload buffer). Fund it at https://faucet.solana.com"

(cd programs/delphi && anchor build)
(cd programs/delphi && anchor idl build -o /tmp/delphi-idl.json >/dev/null)
cmp -s /tmp/delphi-idl.json packages/shared/idl/delphi.json || die "packages/shared/idl/delphi.json is stale; copy /tmp/delphi-idl.json over it and rerun"
solana program deploy "$SO" --program-id keys/delphi-program.json --upgrade-authority "$AUTHORITY" -k "$AUTHORITY" -u "$RPC"
solana program show "$PROGRAM_ID" -u "$RPC" -k "$AUTHORITY"

SOLANA_RPC_URL="$RPC" npm run -s setup:devnet
echo "launch: program, settlement quorum, bond escrow and personas are live on devnet."
echo "launch: next, each signer operator runs: npm run attest -- --keypair <their-key> --post <resolver-url> --watch"
