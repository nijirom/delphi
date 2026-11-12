#!/usr/bin/env bash
set -euo pipefail
# Optional developer setup. Review the upstream installers before running.
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
if ! command -v solana >/dev/null 2>&1; then
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl --proto '=https' --tlsv1.2 -sSfL https://release.anza.xyz/v4.1.2/install -o "$installer"
  sh "$installer"
fi
if ! command -v avm >/dev/null 2>&1; then
  cargo install --git https://github.com/coral-xyz/anchor --tag v1.2.2 avm --locked
fi
avm install 1.2.2
avm use 1.2.2
solana --version
anchor --version
printf '\nAdd to your shell PATH: %s\n' "$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin"
