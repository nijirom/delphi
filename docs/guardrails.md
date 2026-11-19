# Buyer agent guardrails

The buyer agent (`agents/buyer`) holds a devnet USDC wallet and a Gemini
sandbox API key. Every limit below is enforced in code, not just documented;
the file that enforces it is named so judges can check.

## What the agent can never do

| Boundary | Enforced in |
| --- | --- |
| Pay on any network other than Solana devnet, or in any asset other than the configured devnet USDC mint | `index.ts` refuses to start otherwise; `x402.ts` filters every x402 quote by network, asset, recipient and exact amount **before** signing |
| Pay a price different from the on-chain `price_per_read` of the forecaster | `x402.ts` `verifyListing` compares the listing with the `Forecaster` and `Forecast` accounts |
| Follow a redirect or pay a URL outside `FORECASTER_URL`'s origin | `guardrails.ts` `safeUrl`, `fetch` with `redirect: "error"` |
| Sign the same payment twice | one-use transport per reservation in `x402.ts` |
| Trade on Gemini production | blocked unless `BUYER_ALLOW_LIVE_TRADING=true`; sandbox is the default private base |
| Accept Gemini's prediction-market terms on a human's behalf | `GeminiClient.placeOrder` fails closed when `termsStatus().hasAcceptedLatest` is false; the agent never calls `acceptTerms` |
| Place anything other than an immediate-or-cancel limit order with a bounded notional | `loop.ts` builds orders only through `orderPlan` |
| Withdraw, transfer, or sign arbitrary transactions | the wallet is used only for x402 `exact`/`upto` payments and the `record_purchase`/`reveal_and_score` instructions |
| Authorize an `upto` ceiling above the verified on-chain prices, pay a different recipient or asset, sponsor the facilitator's fees, or accept a withdrawal lock over 5 min | `channels.ts` `allowedChannelQuote`; the bundle is reserved in full before signing, and only delivered reads are recorded |

## Spending limits

All amounts are in USDC. Reservations are written to `data/buyer.sqlite`
(`BUYER_DB`) **before** any payment or order is sent, so a crash or an
ambiguous network failure can never spend more than what was reserved. An
uncertain outcome keeps the reservation; it is never retried blindly.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUYER_DRY_RUN` | `true` | Scan, list and report only. No x402 payments, no orders. |
| `BUYER_DAILY_BUDGET_USDC` | 5 | Sum of all reads and trades reserved in a UTC day. |
| `BUYER_PER_MARKET_BUDGET_USDC` | 0.50 | Reads plus trades per instrument. |
| `BUYER_MAX_READ_PRICE_USDC` | 0.05 | Listings above this are never purchased. |
| `BUYER_MIN_FORECASTER_REPUTATION_BPS` | 4000 | Listings below this reputation are ignored. |
| `BUYER_EDGE_THRESHOLD` | 0.06 | Minimum edge versus the executable Gemini price (ask for YES, 1 − bid for NO) after the fee buffer. |
| `BUYER_MAX_POSITION_USDC` | 2 | Worst-case cost of a single position. |
| `BUYER_FEE_BUFFER_BPS` | 200 | Added to the executable price when computing edge and worst-case cost. |
| `BUYER_AUTO_APPROVE_BELOW_USDC` | 0.50 | Trades below this size are placed without a human. |
| `BUYER_VOICE_APPROVE_ABOVE_USDC` | 1.00 | Trades at or above this size need an explicit spoken or typed "yes". Between the two thresholds the agent notifies and proceeds. |

Position size is capped fractional Kelly (≤ 25 %) of the per-market budget,
then bounded by the remaining daily budget and `BUYER_MAX_POSITION_USDC`.
Quantity and price are rounded to the instrument's `quantityIncrement`,
`priceIncrement`, `quantityMinimum` and `priceMinimum`; if Gemini does not
publish those fields the agent does not trade that instrument.

One trade per instrument, ever: the `trade` reservation is keyed by symbol and
persists across restarts.

## Decision loop

Every 30 s (`loop.ts` `tick`):

1. `scan` — fetch the forecaster's listings once, then active binary Gemini
   contracts expiring in 2 min – 24 h with a bid or ask. If either source is
   down the scan stops with one `error` naming the cause (for example
   `forecaster_http_503` or `gemini_http_429`) instead of one per market.
2. For each instrument, keep forecasters above the
   reputation floor and below the read-price cap, one listing per forecaster
   identity, sorted by reputation. When two or more eligible listings share a
   forecaster, they are bought as one `upto` bundle first.
3. `buy` — verify the listing against the chain, reserve the read, pay with
   x402, persist a `2xx` reveal **before** validating it (non-`2xx` error bodies
   are discarded, and reservations that never broadcast a payment are released),
   then check the reveal against the on-chain commitment and the
   `PAYMENT-RESPONSE` settlement.
4. `aggregate` — reputation-weighted log-odds pooling (`@delphi/shared` `pooledForecast`).
5. `decide` — refresh the exact parent event and instrument, not the first page
   of the catalog. Require an active, unresolved binary contract; inherit the
   parent expiry only if the contract has none. Compare the pooled probability
   with the executable price; skip below the edge threshold and size the order.
   Recheck the two-minute expiry safety window after authorization, before
   reserving trade budget. Failed refreshes and rejected candidates emit `skip`.
6. `approve` — auto / notify / human tier as above.
7. `trade` — Gemini limit IOC order, or `skip` when dry-run, credentials or
   terms are missing. `error` is emitted for any blocked or uncertain step.
8. Reconcile (once per tick): record unrecorded purchases while the market is
   still open, and independently call `reveal_and_score` once a purchased market
   has resolved — even if `record_purchase` could not land before resolution.
   Payloads that cannot validate are quarantined instead of retried every tick;
   a forecast already forfeited is terminal.

Every stage is posted to the indexer (`/telemetry`) and shown on the dashboard.

## Human approval by voice (ElevenLabs)

When `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`
and `APPROVER_PHONE_NUMBER` are set, trades at or above
`BUYER_VOICE_APPROVE_ABOVE_USDC` trigger an outbound call
(`POST /v1/convai/twilio/outbound-call`) with dynamic variables
`symbol`, `side`, `size`, `edge`. The agent polls
`GET /v1/convai/conversations/{id}` until `status` is `done` and proceeds only if
`analysis.data_collection_results.approved.value === true`. Any other outcome,
a failed call, or 180 s without an answer is a denial.

Configure the ElevenLabs agent as follows:

- System prompt: "You are the approval line for an autonomous trading agent on
  Gemini prediction markets. Read the proposed trade: {{side}} on {{symbol}},
  up to {{size}} USDC, estimated edge {{edge}}. Ask the caller whether they
  approve. Accept only a clear yes or no. Repeat the answer back, then end the
  call."
- Data collection: field `approved`, type boolean, description "true only if
  the caller explicitly approved the trade".
- Tool: `end_call` so the agent hangs up after confirming.
- Phone number: a Twilio number imported into ElevenLabs; its ID is
  `ELEVENLABS_PHONE_NUMBER_ID`.

Without those variables the agent asks on the terminal (interactive TTY only)
and denies after 60 s. In a non-interactive process the trade is denied.

## Kill switch

- `BUYER_DAILY_BUDGET_USDC=0` or `BUYER_DRY_RUN=true` stops all spending on the next tick.
- Deleting `keys/buyer.json` makes the agent fail to start in paid mode.
- Moving USDC out of the buyer's token account bounds the worst case regardless of software state.
