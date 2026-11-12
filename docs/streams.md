# QuickNode Streams configuration

The indexer (`services/indexer`) is fed by a QuickNode Stream that watches the
Delphi program and the forecasters' USDC token accounts on Solana devnet and
pushes matching transactions to `POST /webhooks/streams`. Streams delivers
blocks sequentially and retries until the endpoint returns 2xx, so the
reputation leaderboard and payment attribution never miss or reorder an event
and the indexer never polls.

Without a QuickNode account, run the indexer with `INDEXER_SOURCE=rpc`; it polls
`getSignaturesForAddress` for the same addresses and feeds the same decoder.

## Stream settings

| Field | Value |
| --- | --- |
| Network | Solana Devnet |
| Dataset | Block (`getBlock` payload; Devnet supports Block and Programs + Logs) |
| Stream start | The slot the program was deployed in (backfill, paid plans) or Latest block |
| Filter | "Modify the payload before streaming" with the function below |
| Destination | Webhook, `https://<public-host>/webhooks/streams` |
| Custom header | `x-streams-secret: <STREAMS_WEBHOOK_SECRET>` |
| Payload compression | None |
| Timeout / retry / pause | 30 s / 1 s / 3 (defaults) |

Local development: expose the indexer with `ngrok http 4030` (or `cloudflared
tunnel --url http://localhost:4030`) and use that hostname in the destination.
Set the same secret in `.env`; the indexer rejects requests whose header does not
match (constant-time comparison) and refuses to start with an empty or
`change-me` secret. For defense in depth also enable the QuickNode security token
or mTLS; neither replaces the shared header, which is what binds a delivery to
this deployment.

## Filter function

Replace the two constants with the deployed program ID and the forecasters'
USDC associated token accounts printed by `npm run setup:devnet`.

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

Returning `null` for blocks without matches skips the delivery. The indexer also
accepts unfiltered Block payloads (`{ data: [block, ...] }`), so the filter is an
optimisation, not a requirement.

## What the indexer does with a delivery

1. Authenticates the `x-streams-secret` header, caps the body at 8 MB, and
   validates the shape of every row.
2. Skips rows with `err` set and rows whose signature was already stored
   (deliveries are retried; replays are idempotent).
3. Decodes Anchor events from `logMessages` with the program's IDL
   (`packages/shared/idl/delphi.json`) using `EventParser`, which only decodes
   logs emitted inside a Delphi invocation. Events map to
   `forecast_posted`, `purchase_recorded`, `market_resolved`, `forecast_scored`
   and are enriched with the instrument symbol from the on-chain `Market`.
4. Computes USDC received by each forecaster from the pre/post token balance
   delta of the configured mint and stores it as `usdc_transfer`. Earned USDC on
   the leaderboard comes only from these confirmed balance changes.
5. Broadcasts each new event over `GET /stream` (SSE) to the dashboard.

## Trust notes

- `record_purchase` stores a buyer-supplied payment signature and does not
  verify the transfer on-chain. Reads shown on the leaderboard are therefore
  buyer-reported; earnings are chain-confirmed.
- Reputation depends only on `reveal_and_score`, which verifies the commitment
  on-chain. Phantom purchases cannot change it.
