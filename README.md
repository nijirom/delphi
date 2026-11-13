# Delphi

**A forecast micro-market for AI agents.** Forecasters sell probability
estimates on live Gemini Prediction Market contracts, priced per read. Buyer
agents pay per read in USDC on Solana via x402, pool what they bought by
on-chain reputation, and trade on Gemini only when they find edge. When Gemini
settles, every purchased forecast is revealed and Brier-scored on-chain.
Reputation is earned, not claimed.

Built for the University Blockchain Conference 2026 hackathon.

- Main track: **Agentic Payments and AI**
- Chain award: **Best use of Solana**
- Bounties: Gemini Prediction Markets, QuickNode Streams, ElevenLabs

## What it does

1. Three forecaster personas post forecasts on near-expiry Gemini contracts
   (5–15 minute crypto Up/Down, NBA moneylines). Only a `sha256(prob ‖ salt)`
   commitment goes on-chain.
2. A buyer agent with a USDC budget discovers forecasts, pays per read with
   x402 (`exact` scheme, devnet USDC), and records each purchase on-chain.
3. It pools the purchased forecasts with reputation-weighted log-odds and
   compares to the Gemini mid. If edge exceeds the threshold it sizes a
   position with capped Kelly and, above a dollar threshold, phones the
   approver through an ElevenLabs voice agent before trading.
4. The resolver mirrors Gemini settlements on-chain. Forecasts are revealed and
   scored; forecaster reputation updates. Buyers can reveal what they bought.
5. QuickNode Streams pushes program activity to the indexer; the dashboard
   shows searchable market cards, sampled Gemini quotes, forecaster reputation,
   and the buyer agent's latest decision.

Architecture, decision loop, and trust assumptions: [docs/architecture.md](docs/architecture.md).
Guardrails and kill switch: [docs/guardrails.md](docs/guardrails.md).
QuickNode Streams configuration: [docs/streams.md](docs/streams.md).

## Addresses (Solana devnet)

| What | Address |
| --- | --- |
| Delphi program | `EVqrBtTWaQiwnrhXzDgqr5TML6oDpHqHs5jjeLLg42Qc` |
| USDC mint (Circle devnet) | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

Forecaster and buyer keys are generated locally by `npm run setup:devnet`.

## Sponsor tools

| Tool | Where | How |
| --- | --- | --- |
| Solana | `programs/delphi`, `packages/shared/src/solana.ts` | Anchor program for registry, commit–reveal, purchases, resolution, scoring. All payments are SPL USDC on devnet. |
| x402 | `services/forecaster/src/server.ts`, `agents/buyer/src/x402.ts` | `@x402/express` paywalls each forecast read; the agent pays with `@x402/fetch` + `@x402/svm`. |
| Gemini Prediction Markets | `packages/shared/src/gemini.ts` | Market data for candidate contracts and mid prices; `recently-settled` + `resolutionSide` as the scoring oracle; order placement for the trade leg. |
| QuickNode Streams | `services/indexer`, `docs/streams.md` | Filtered devnet stream of program transactions and USDC transfers → webhook → SQLite → SSE. |
| ElevenLabs | `agents/buyer/src/approval.ts` | Conversational AI outbound call for human approval on large trades; the spoken answer is a data-collection field the agent reads back. |

## Run it

Prerequisites: Node 26, Rust + Solana CLI 4.x + Anchor 1.2.2 (`scripts/install-toolchain.sh`).

```bash
npm install
cp .env.example .env                        # fill in keys as needed

# 1. keys, devnet SOL, USDC token accounts
npm run setup:devnet

# 2. build + deploy the program (once)
cd programs/delphi && anchor build && anchor deploy --provider.cluster devnet && cd ../..
npm run setup:devnet                        # registers forecasters now that the program exists

# 3. fund the buyer's devnet USDC account: https://faucet.circle.com

# 4. services (separate terminals)
npm run indexer
npm run forecaster
npm run resolver
npm run buyer
npm run web                                 # http://localhost:5173
```

`BUYER_DRY_RUN=true` (default) logs Gemini orders instead of sending them. Set
`GEMINI_API_KEY`/`GEMINI_API_SECRET` (sandbox or production) and
`BUYER_DRY_RUN=false` to trade. Leave the ElevenLabs variables blank to approve
large trades from the terminal instead of by phone.

`INDEXER_SOURCE=rpc` polls the devnet RPC when you do not have a QuickNode
Streams webhook reachable; `streams` is the default and is documented in
[docs/streams.md](docs/streams.md).

## Dashboard

The web app uses a compact market-browser and terminal layout with Delphi's
dark teal/mint palette. Search and category filters, grid/list views, and sorting
operate on markets already initialized in the Delphi program—not the entire
Gemini catalog. Forecasters and Activity are separate views.

Open a market for sampled Yes-mid history, chart windows, committed/revealed
forecasts, bid/ask quotes, purchase/scoring activity, and a **read-only** agent
decision panel. It does not submit orders. Pooled probability and sizing are
carried forward only within the same buyer scan; later skip/error/trade stages
take precedence over an earlier decision.

The indexer exposes `GET /markets`, `GET /markets/:symbol`, and
`GET /categories`, alongside its existing leaderboard, events, telemetry, and
SSE endpoints. Vite proxies these through `/api`. Quotes are sampled during
indexer refreshes (10 seconds in RPC mode, 30 seconds in Streams mode, plus
upstream fetch time), with seven days of samples retained in SQLite. These are
locally collected observations, not Gemini historical candles or an order book.
Missing data stays empty; no chart history or purchases are fabricated.

The browser refreshes snapshots every 15 seconds and on SSE activity. Backend
failures retain the last successful snapshot with an alert. The layout adapts
to narrow screens; wide forecast and leaderboard tables scroll inside panels.

## Repository layout

```
programs/delphi      Anchor program (Rust) + litesvm tests
packages/shared      Gemini client, math, PDAs, DelphiProgram client, env
services/forecaster  x402-paid forecast API + persona forecasters
services/resolver    Gemini settlement → resolve_market → reveal_and_score
services/indexer     Streams webhook / RPC poller → SQLite → REST + SSE
agents/buyer         Buyer agent loop, guardrails, approval, trading
apps/web             Vite + React dashboard
docs                 architecture, guardrails, streams
scripts              setup-devnet, install-toolchain
```

## What we would build next

- Attested settlement: replace the single oracle key with a multisig and a
  signed attestation of Gemini's `resolutionSide`.
- Forecaster staking: slash stake for forecasts that are never revealed.
- Usage-based reads with x402 `upto` payment channels to cut per-read fees.
- Open the forecaster API so humans and third-party agents can list forecasts.
