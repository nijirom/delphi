# Delphi

**A forecast micro-market for AI agents.** Forecasters sell probability
estimates on live Gemini Prediction Market contracts, priced per read. Buyer
agents pay per read in USDC on Solana via x402, pool what they bought by
on-chain reputation, and trade on Gemini only when they find edge. When Gemini
settles, purchased forecasts are revealed and Brier-scored on-chain. A
commitment still unrevealed an hour later is forfeited at the worst score.
Reputation is shrunk toward an unscored baseline, not claimed from one call.

Built for the University Blockchain Conference 2026 hackathon.

- Main track: **Agentic Payments and AI**
- Chain award: **Best use of Solana**
- Bounties: Gemini Prediction Markets, QuickNode Streams, ElevenLabs

## What it does

1. Three forecaster personas post commitments on near-expiry Gemini contracts.
   `quant` prices crypto strike contracts from Gemini spot and realized vol
   (and abstains without a strike); `momentum` and `contrarian` are
   mid-derived baselines. Only a `sha256(prob ‖ salt)` commitment goes on-chain.
2. A buyer agent with a USDC budget discovers forecasts, pays per read with
   x402 (`exact` scheme, devnet USDC), and records each purchase on-chain.
3. It pools the purchased forecasts with reputation-weighted log-odds and
   compares to the Gemini mid. If edge exceeds the threshold it sizes a
   position with capped Kelly and, above a dollar threshold, phones the
   approver through an ElevenLabs voice agent before trading.
4. A 2-of-3 quorum of independent settlement signers each reads Gemini and
   signs the outcome; the resolver relays those signatures to the program,
   which verifies them with the Ed25519 precompile. It reveals forecasts it
   holds, and an hour later forfeits every commitment still unrevealed.
   Reputation updates from that score. Buyers can reveal what they bought
   before the window closes. A forecaster may bond USDC on a forecast; the bond
   is refunded on reveal and slashed to the treasury on forfeit.
5. QuickNode Streams pushes program activity to the indexer; the dashboard
   shows searchable market cards, sampled Gemini quotes, forecaster reputation,
   and the buyer agent's latest decision.

Architecture, decision loop, and trust assumptions: [docs/architecture.md](docs/architecture.md).
Guardrails and kill switch: [docs/guardrails.md](docs/guardrails.md).
QuickNode Streams configuration: [docs/streams.md](docs/streams.md).

## Addresses (Solana devnet)

| What | Address |
| --- | --- |
| Delphi program ID (fixed by `keys/delphi-program.json`, `declare_id!`) | `EVqrBtTWaQiwnrhXzDgqr5TML6oDpHqHs5jjeLLg42Qc` |
| USDC mint (Circle devnet) | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Upgrade / bootstrap authority | `BmLjQD8MeRzaZmxPvVGgjwFbfJeFGNffnmafDYSodzqf` |
| Settlement signers (2-of-3) | `9QjZYBUMYBfXxN3bT2vYwbp5Gp1o1hwv3xKfNNSc7LkX`, `8YU3DeeDVYe9WvvcbtdNrc19t9t1mvyr8Cday7zHsQFk`, `G6JKTUbidBMe5j5JSwao1c3GdwgG6skS6kT93sMDyfwc` |
| Bond slash treasury (USDC) | `424HhQ1WDteLm6jwtYfoCVVqup57ZpWzdwTzsQ3be7Qu` |

**Deployment status:** deployed to Solana devnet in slot 522344596, transaction
[`5yTTJTx7…YRh1HJwZ3`](https://explorer.solana.com/tx/5yTTJTx7KSYCGnj2aDByvnNr2eARarixPysZRNRvYvN9dDidd1HXewVZBaJocU8FJ7CRpsJTFXLxK3XRYh1HJwZ3?cluster=devnet).
The settlement quorum, bond escrow and three personas are initialized on-chain;
personas post live commitments on Gemini contracts and markets resolve by
signer quorum. `upto` channel reads were exercised on a local validator with
the devnet payment-channels program cloned in, then on devnet itself. Use a
dedicated devnet RPC (`SOLANA_RPC_URL`, e.g. a QuickNode endpoint): the public
endpoint rate-limits `getProgramAccounts` per IP. With free-tier limits, set a
second endpoint as `SOLANA_READ_RPC_URL`; `npm run devnet` moves the indexer and
settlement signers onto it so payments and claims keep the first one's budget.

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

# 2. deploy the program and initialize quorum, bonds and personas (guarded, one command)
#    needs >= 6 SOL on keys/oracle.json (faucet.solana.com); signer keys must live with separate operators
SETTLEMENT_SIGNERS=<pk1>,<pk2>,<pk3> BOND_TREASURY_TOKEN_ACCOUNT=<usdc-ata> npm run launch:devnet

# 3. fund the buyer's devnet USDC account: https://faucet.circle.com

# 4. services: everything in one command (logs in data/logs/)
#    keys in ~/.config/delphi/{facilitator,channel-authorizer}.json and signers/signer-{1,2}.json
DEVNET_PUBLIC=1 BUYER_DRY_RUN=false npm run devnet
#    or individually: npm run facilitator | indexer | forecaster | resolver | buyer | web

# 5. publish the forecaster, resolver and dashboard (Cloudflare quick tunnels; no account)
npm run expose                              # prints public URLs, writes data/public-urls.env
#    restart the forecaster with FORECASTER_URL=<printed forecaster URL>

# 6. each settlement signer, on its own machine with its own key
npm run attest -- --keypair ~/.config/delphi/signers/signer-1.json --post <printed resolver URL> --watch
```

`BUYER_DRY_RUN=true` (default) logs Gemini orders instead of sending them. Set
`GEMINI_API_KEY`/`GEMINI_API_SECRET` (sandbox or production) and
`BUYER_DRY_RUN=false` to trade. Leave the ElevenLabs variables blank to approve
large trades from the terminal instead of by phone.

`INDEXER_SOURCE=rpc` polls the configured Solana RPC when you do not have a QuickNode
Streams webhook reachable; `streams` is the default and is documented in
[docs/streams.md](docs/streams.md).

### Settlement quorum

`resolve_market` no longer accepts the oracle key. It requires
`threshold` Ed25519 signatures from distinct keys in the immutable
`SettlementConfig` (2–5 signers, threshold ≥ 2) over
`sha256("delphi:settlement:v1" ‖ program ‖ config ‖ market ‖ outcome)`.
Each signer runs `npm run attest`, which queries Gemini itself and writes a
signature to `SETTLEMENT_ATTESTATIONS_DIR` (default `data/attestations`) only
for a contract Gemini reports as settled Yes or No. The resolver only relays
signatures: its key is a fee payer, not a vote. Sharing that directory between
machines (or a bucket) is the transport; a signature bound to another program,
market, config or outcome never counts.

### Forecast bonds

`FORECAST_BOND_MICRO_USDC` (default 0) makes the persona forecaster escrow that
much USDC with every new commitment, in the same transaction. The vault is a
PDA owned by the program. `reveal_and_score` returns the bond to the
forecaster's token account; `forfeit_forecast` slashes it to
`BOND_TREASURY_TOKEN_ACCOUNT`. Settlement is permissionless and the resolver
sweeps any unsettled bond, so neither side has to cooperate.

### Publishing your own forecasts

Anyone with a Solana wallet can sell forecasts through this server:

```bash
npm run publish:forecast -- --keypair keys/my-wallet.json --name my-name \
  --event BTC05M2611142200 --symbol GEMI-BTC05M2611142200-UP --prob-bps 6500
```

The CLI registers the wallet, posts the commitment on-chain from that wallet,
keeps the salt in a local SQLite file, and uploads the reveal in a
wallet-signed envelope (`POST /publications`; schema at `GET /publishing`).
The key never leaves the machine. Signatures are bound to this server, program
and chain, expire in five minutes, and carry a single-use nonce. The server
re-derives the forecast PDA from the signer, checks the commitment opens on
chain, and lists it next to the personas. Buyers pay the publisher's own USDC
account directly via x402. Agents can implement the same envelope without the
CLI.

### Usage-based reads (x402 `upto`)

When several listings from one forecaster are eligible in a scan, the buyer
asks for a bundle quote (up to 16 reads), authorizes the exact sum of the
on-chain prices as a ceiling with the x402 `upto` scheme, and the server
settles only the reads it actually delivered — one escrow and one claim
instead of one transfer per read. Single listings still use `exact`. Enable on
the server with `FORECASTER_CHANNEL_AUTHORIZER_KEYPAIR`; the buyer uses it by
default (`BUYER_PAYMENT_SCHEME=exact` disables it). `upto` needs a facilitator
that supports it; `npm run facilitator` (`FACILITATOR_KEYPAIR`) runs a private
one that persists signed settlement bytes before broadcast.

## Dashboard

The web app uses a compact market-browser and terminal layout with Delphi's
dark teal/mint palette. Search and category filters, grid/list views, and sorting
operate on markets already initialized in the Delphi program—not the entire
Gemini catalog. Forecasters and Activity are separate views.

The default **Live first** order puts active, unexpired contracts ahead of
history, with the nearest expiry first. Non-live markets follow newest first;
explicit expiry, reads, and forecast-count sorting remain available.

The network badge and explorer links use the indexer's runtime cluster and
program ID from `GET /health`, not a hardcoded devnet address. Public clusters
are identified by their genesis hash. Local/custom RPCs do not generate public
explorer links, and the RPC URL (which may contain credentials) is not exposed.
Use **Docs** for bundled documentation; no access to the private repository is
needed.

Open a market for sampled Yes-mid history, chart windows, committed, revealed,
and forfeited forecasts, bid/ask quotes, purchase/scoring activity, and a **read-only** agent
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
Market terminals query events and telemetry by instrument before applying the
300-row limit, rather than filtering the global feed. This is a recent indexed
window, not a complete audit history: the terminal shows on-chain read/score
totals separately and distinguishes loading, unavailable, and empty results.

The browser refreshes snapshots every 15 seconds and on SSE activity. A stream
permanently closed by an HTTP error is reopened after three seconds; a service
restart does not require reloading the page. Every
quote carries its observation age; observations older than two minutes are
marked stale, and a stale chain snapshot or unreachable indexer is reported in
the status bar with the last successful data retained. The layout adapts to
narrow screens; wide forecast and leaderboard tables scroll inside panels.

## Repository layout

```
programs/delphi      Anchor program (Rust) + litesvm tests
packages/shared      Gemini client, math, PDAs, DelphiProgram client, env
services/forecaster  x402-paid forecast API + persona forecasters
services/resolver    Gemini settlement → resolve_market → reveal_and_score; forfeit_forecast after one hour
services/indexer     Streams webhook / RPC poller → SQLite → REST + SSE
agents/buyer         Buyer agent loop, guardrails, approval, trading
apps/web             Vite + React dashboard
docs                 architecture, guardrails, streams
scripts              setup-devnet, install-toolchain
```

## What we would build next

- Run the settlement signers on separate infrastructure and publish their
  attestations to a shared bucket instead of a shared directory.
- Scale bond size with reputation, so unproven forecasters must stake more.
- Long-lived `batch-settlement` channels so a buyer funds one channel per
  forecaster for days, not one per scan.
- A web form for human publishers that signs with a browser wallet.
