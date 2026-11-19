# Delphi session handoff

## Purpose

This file preserves the actionable state of the development session without copying credentials, private keys, tokens, temporary public URLs, or raw chat history.

## Project

Delphi is a pay-per-read forecast marketplace built from:

- an Anchor program on Solana;
- x402 exact USDC payments and optional `upto` payment channels;
- Gemini Prediction Markets data and settlement;
- a buyer agent with budget, liquidity, reputation, and approval guardrails;
- a forecaster service and permissionless publisher protocol;
- a 2-of-3 signed settlement quorum;
- a QuickNode Streams/RPC indexer;
- a React dashboard.

## Current status

The devnet prototype has exercised forecast publication, paid reads, payment-channel bundles, bonds, settlement attestations, reveal/scoring, reputation updates, indexing, and public dashboard access. It is a hackathon demo, not a production financial service.

No commit or public deployment was performed during the final hardening work. The working tree intentionally contains substantial uncommitted changes.

## Major completed work

- Added unrevealed-forecast forfeiture and shrinkage reputation handling.
- Added settlement quorum attestations and signer tooling.
- Added forecast bonds, refunds, and silence slashing.
- Added exact x402 payment safeguards and optional bundled channel reads.
- Conservatively retain exact-payment reservations after signed ambiguous failures.
- Validate channel responses before persistence.
- Verify missing-read channel settlement against on-chain channel state before releasing budget.
- Bound channel recovery, persist retry/backoff state, and cap/prune unpaid quotes.
- Added permissionless third-party forecast publishing with signed envelopes and replay protection.
- Hardened buyer listing verification, market linkage, quote use, payment persistence, reconciliation, and telemetry.
- Count indexer earnings only when a matching forecast purchase exists in the same transaction.
- Added source-specific indexer readiness, ingestion-gap reporting, Streams freshness, and QuickNode webhook signature verification.
- Added persisted quote fallback and matchup/cadence symbol enrichment.
- Hardened logging and shared-RPC behavior.
- Improved dashboard market, chart, activity, docs, network, bond, outcome, and responsive layouts.
- Fixed right-side clipping across tested widths from 1024 px through 1440 px.

## Last verification

Executed from the repository root:

```sh
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
npm test
npm run typecheck
npm run build
(cd programs/delphi && cargo test --offline)
```

Observed results:

- TypeScript tests: 76 passed, 0 failed.
- Typecheck: clean.
- Web production build: clean.
- Anchor lifecycle tests: 3 passed, 0 failed.

Focused buyer/forecaster/indexer regression run: 61 passed, 0 failed.

## Important operating constraints

- Use devnet/test funds only.
- Do not commit secrets, `.env`, wallet files, signer files, RPC credentials, webhook tokens, or temporary tunnel URLs.
- Keep `BUYER_DRY_RUN=true` unless intentionally demonstrating a small devnet payment.
- Prefer exact x402 payments for a reliable demo. Enable `upto` channels only when demonstrating that feature and with adequate RPC capacity.
- Reputation arithmetic intentionally uses integer truncation; do not change known values merely to make them round differently.
- Toolchain path may require `$HOME/.cargo/bin` and the active Solana release directory.
- `bun` is not required or installed.

## Demo narrative

1. Show a live Gemini market and several committed forecasts.
2. Explain that commitments prevent predictions from changing after publication.
3. Show a devnet USDC x402 paid read and the corresponding Solana purchase evidence.
4. Show reputation-weighted aggregation and a guarded trade or justified abstention.
5. Show 2-of-3 settlement attestations.
6. Show reveal, Brier scoring, reputation movement, and bond refund/slash state.
7. Show the leaderboard and architecture page.
8. Close with: “Delphi: a marketplace where predictions earn their reputation.”

## Production caveats

Before real funds: rotate all credentials, use independently operated settlement signers, obtain an external audit, use durable hosting and managed secrets, add multiple RPC providers, introduce multisig/timelocks, run accounting reconciliation and incident drills, and complete legal review.

## Local configuration

The real configuration remains in ignored local files. Do not copy values into this handoff. Review `.env.example` for variable names. The repository already has an `origin`; do not replace or add another remote.
