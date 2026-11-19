# QuickNode Streams configuration

The indexer (`services/indexer`) can be fed by a QuickNode Stream that watches
the Delphi program and the configured forecasters' USDC token accounts on
Solana devnet and pushes matching transactions to `POST /webhooks/streams`.
Streams orders batches and retries failed webhook requests, which reduces
delivery gaps. It does not prove that a static filter is complete or that every
historical transaction was delivered.

Without a QuickNode account, run the indexer with `INDEXER_SOURCE=rpc`; it polls
`getSignaturesForAddress` for the same addresses and feeds the same decoder.

## Stream settings

| Field | Value |
| --- | --- |
| Network | Solana Devnet |
| Dataset | Block (`getBlock` payload; Devnet supports Block and Programs + Logs) |
| Stream start | The slot the program was deployed in (backfill, paid plans) or Latest block |
| Filter | "Modify the payload before streaming" with the function below |
| Destination | Webhook, `https://<public-host>/webhooks/streams` (with `npm run expose`: `<dashboard URL>/api/webhooks/streams`) |
| Authentication | Security token → `STREAMS_SECURITY_TOKEN` (preferred), or custom header `x-streams-secret: <STREAMS_WEBHOOK_SECRET>` |
| Payload compression | None |
| Timeout / retry / pause | 30 s / 1 s / 3 (defaults) |

Local development: `npm run expose` publishes the dashboard, whose `/api` proxy
reaches the indexer; use `<dashboard URL>/api/webhooks/streams`.

A delivery is accepted if either credential checks out:

- **QuickNode signature** (preferred): set `STREAMS_SECURITY_TOKEN` to the Stream's
  security token. The indexer recomputes HMAC-SHA256 over `nonce + timestamp + body`
  from the `x-qn-nonce`, `x-qn-timestamp` and `x-qn-signature` headers, compares in
  constant time, and refuses timestamps more than five minutes off, so a captured
  delivery cannot be replayed later or altered in transit.
- **Shared header**: `x-streams-secret` must equal `STREAMS_WEBHOOK_SECRET`. The
  indexer refuses to start with an empty or `change-me` secret.

Requests carrying neither credential are refused before the body is read.
`GET /health` reports `streams.{deliveries,rows,rejected,unauthorized,lastAt,
deliveryState,staleAfterMs}`. `deliveryState` is `no_deliveries` until this
indexer process accepts its first delivery, `receiving` while the last accepted
delivery is recent, and `stale` after three minutes without one. Because the
filter returns `null` for blocks without matches, `stale` means only that no
matching delivery was observed; it cannot by itself distinguish a quiet chain
from a delivery outage. `readiness.source` exposes this as `incomplete`,
`ready`, or `degraded`. RPC polling exposes recipient-history failures and
permanently dropped signatures under `rpc`.

## Filter function

Replace the two constants and owner list with the deployed program ID, mint,
and forecaster authorities printed by `npm run setup:devnet`.

```js
const PROGRAM_ID = 'EVqrBtTWaQiwnrhXzDgqr5TML6oDpHqHs5jjeLLg42Qc';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const FORECASTER_OWNERS = [
  // persona authority pubkeys from `npm run setup:devnet`
];


function main(stream) {
  const rows = [];
  const blocks = stream.data;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    // Block dataset has no slot field; one block per batch entry maps to the batch range.
    const slot = Number(stream.metadata.batch_start_range) + i;
    for (const tx of block.transactions || []) {
      const keys = (tx.transaction.message.accountKeys || []).map(k => (typeof k === 'string' ? k : k.pubkey));
      const touchesProgram = keys.includes(PROGRAM_ID);
      const usdc = [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]
        .some(b => b.mint === USDC_MINT && FORECASTER_OWNERS.includes(b.owner));
      if (!touchesProgram && !usdc) continue;
      rows.push({
        signature: tx.transaction.signatures[0],
        slot,
        blockTime: block.blockTime,
        err: tx.meta.err,
        logMessages: tx.meta.logMessages || [],
        accountKeys: keys,
        preTokenBalances: tx.meta.preTokenBalances || [],
        postTokenBalances: tx.meta.postTokenBalances || [],
      });
    }
  }
  return rows.length ? rows : null;
}
```

`FORECASTER_OWNERS` is a static allowlist. Whenever a forecaster is registered
or its authority changes, add the new authority and redeploy/update the Stream
filter before relying on its payment activity. Removing a forecaster also
requires a filter update. The indexer cannot discover an omitted owner from a
payload that the filter never sends; `GET /health` therefore reports observed
delivery state, not filter completeness. Use an appropriate Stream start slot
or an RPC backfill when historical coverage matters.

Returning `null` for blocks without matches skips the delivery. The indexer also
accepts unfiltered Block payloads (`{ data: [block, ...] }`), so the filter is an
optimisation, not a requirement.

## What the indexer does with a delivery

1. Authenticates either the QuickNode signature or `x-streams-secret`, caps the
   body at 8 MB, and validates the shape of every row.
2. Skips rows with `err` set and rows whose signature was already stored
   (deliveries are retried; replays are idempotent).
3. Decodes Anchor events from `logMessages` with the program's IDL
   (`packages/shared/idl/delphi.json`) using `EventParser`, which only decodes
   logs emitted inside a Delphi invocation. Events map to
   `forecast_posted`, `purchase_recorded`, `market_resolved`, `forecast_scored`
   and are enriched with the instrument symbol from the on-chain `Market`.
4. Stores positive USDC balance deltas for configured forecasters as transfer
   activity. A delta contributes to leaderboard earnings only when the same
   transaction contains a `purchase_recorded` event for that forecaster and
   the recorded amount exactly equals the received amount. Bond refunds,
   direct transfers, mixed amounts, and other unmatched receipts remain visible
   as unattributed `usdc_transfer` events but do not increase earnings.
5. Broadcasts each new event over `GET /stream` (SSE) to the dashboard.

## Trust notes

- `record_purchase` stores a buyer-supplied payment signature and does not
  independently verify that signature's transfer. Reads shown on the
  leaderboard are therefore buyer-reported. Earnings require both an incoming
  token balance delta and matching purchase evidence in the same transaction;
  unmatched receipts are deliberately not counted.
- Reputation depends only on `reveal_and_score` and `forfeit_forecast`.
  Reveals verify the commitment on-chain; forfeits apply the worst Brier after
  the reveal window. Phantom purchases cannot change it.
