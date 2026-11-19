import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import type { PaymentRequirements } from '@x402/core/types';
import type { DelphiProgram } from '@delphi/shared';
import { allowedChannelQuote, recoverChannels, restoreBundle, type Bundle, type ChannelBuyerOptions } from './channels.js';
import { DEVNET, DEVNET_USDC, Ledger } from './guardrails.js';
import type { VerifiedListing } from './x402.js';

const recipient = 'Forecaster1111111111111111111111111111111111', payer = 'Buyer11111111111111111111111111111111111111';
const item = (amount: number, to = recipient) => ({ amount, recipient: to }) as VerifiedListing;
const items = [item(10000), item(10000), item(5000)];
const quote = (over: Partial<PaymentRequirements> = {}, extra: Record<string, unknown> = {}): PaymentRequirements => ({
  scheme: 'upto', network: DEVNET, asset: DEVNET_USDC, payTo: recipient, amount: '25000', maxTimeoutSeconds: 120,
  extra: { feePayer: 'Facilitator111111111111111111111111111111111', receiverAuthorizer: 'Authorizer1111111111111111111111111111111111', withdrawDelay: 300, ...extra }, ...over,
} as PaymentRequirements);

test('a ceiling exactly equal to the verified on-chain prices is accepted', () => {
  assert.equal(allowedChannelQuote(quote(), items, payer), true);
});

test('a server cannot inflate the ceiling, redirect funds, or swap the asset or network', () => {
  for (const bad of [quote({ amount: '25001' }), quote({ payTo: payer }), quote({ asset: 'So11111111111111111111111111111111111111112' }), quote({ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }), quote({ scheme: 'exact' })]) {
    assert.equal(allowedChannelQuote(bad, items, payer), false);
  }
});

test('the buyer never sponsors fees and refuses long withdrawal locks', () => {
  assert.equal(allowedChannelQuote(quote({}, { feePayer: payer }), items, payer), false);
  assert.equal(allowedChannelQuote(quote({}, { withdrawDelay: 86400 }), items, payer), false);
  assert.equal(allowedChannelQuote(quote({ maxTimeoutSeconds: 3600 }), items, payer), false);
});

test('bundles must be one recipient and at least two reads, or exact is cheaper', () => {
  assert.equal(allowedChannelQuote(quote({ amount: '10000' }), [item(10000)], payer), false);
  assert.equal(allowedChannelQuote(quote({ amount: '20000' }), [item(10000), item(10000, payer)], payer), false);
});

test('a persisted bundle restores the exact 32-byte commitment whether it came from a Buffer or a Uint8Array', () => {
  const bytes = Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256);
  for (const commitment of [Buffer.from(bytes), Uint8Array.from(bytes)]) {
    const bundle = { id: 'a'.repeat(64), url: 'http://127.0.0.1:4020/channels/reads/x', items: [{ ...item(10000), commitment }] } as Bundle;
    // What Ledger.saveBundle stores, through the same JSON round trip SQLite imposes.
    const stored = JSON.stringify({ ...bundle, items: bundle.items.map(x => ({ ...x, commitment: Array.from(x.commitment) })) });
    assert.deepEqual(Array.from(restoreBundle(stored).items[0]!.commitment), bytes);
  }
  // The pre-fix encoding of a Buffer must be refused rather than silently truncated to two bytes.
  const legacy = JSON.stringify({ id: 'b', url: 'u', items: [{ ...item(1), commitment: Buffer.from(bytes) }] });
  assert.throws(() => restoreBundle(legacy), /Corrupt persisted commitment/);
});

function recoverableBundle(id: string, recipient: string): Bundle {
  const items = Array.from({ length: 2 }, (_, index): VerifiedListing => {
    const forecastPda = Keypair.generate().publicKey.toBase58();
    return {
      amount: 10000,
      recipient,
      url: `https://forecaster.test/forecasts/${forecastPda}`,
      commitment: new Uint8Array(32),
      listing: {
        forecastPda,
        forecasterPda: Keypair.generate().publicKey.toBase58(),
        forecasterAuthority: recipient,
        forecasterName: 'Fixture',
        instrumentSymbol: `TEST-${id.slice(0, 4)}-${index}`,
        pricePerReadUsdc: 0.01,
        reputationBps: 5000,
        scoredCount: 1,
        postedAt: 1,
        url: `https://forecaster.test/forecasts/${forecastPda}`,
      },
    };
  });
  return { id, url: `https://forecaster.test/channels/reads/${id}`, items, paymentHeader: 'persisted-signed-authorization' };
}
function storeBundle(ledger: Ledger, bundle: Bundle): void {
  const payload = { ...bundle, items: bundle.items.map(x => ({ ...x, commitment: Array.from(x.commitment) })) };
  assert.equal(ledger.reserveBundle(bundle.id, bundle.items.map(x => ({ key: x.listing.forecastPda, symbol: x.listing.instrumentSymbol, amount: x.amount })), payload), true);
}
function recoveryOptions(ledger: Ledger, wallet: Keypair, request: typeof fetch): ChannelBuyerOptions {
  return {
    base: 'https://forecaster.test',
    rpcUrl: 'https://rpc.invalid',
    wallet,
    program: {} as DelphiProgram,
    programId: Keypair.generate().publicKey,
    ledger,
    fetch: request,
  };
}

test('an invalid channel response remains replayable and retry backoff survives reopening the ledger', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'delphi-channel-invalid-'));
  const path = join(dir, 'ledger.sqlite');
  let ledger = new Ledger(path, 1000000, 1000000, 1000000);
  t.after(() => {
    if (ledger.db.open) ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const wallet = Keypair.generate();
  const bundle = recoverableBundle('d'.repeat(64), Keypair.generate().publicKey.toBase58());
  storeBundle(ledger, bundle);
  let requests = 0;
  const request = (async () => {
    requests++;
    return Response.json({ id: bundle.id, amount: '0', forecasts: [{ forecastPda: 'not-requested' }] }, { headers: { 'PAYMENT-RESPONSE': 'invalid' } });
  }) as typeof fetch;
  const now = 1000000;
  await recoverChannels(recoveryOptions(ledger, wallet, request), now);
  assert.equal(requests, 1);
  const first = ledger.db.prepare('SELECT payload,attempted_at,retry_at FROM bundles WHERE id=?').get(bundle.id) as { payload: string; attempted_at: number; retry_at: number };
  assert.equal((JSON.parse(first.payload) as Bundle).value, undefined, 'invalid content must not replace the replayable authorization');
  assert.equal(first.attempted_at, now);
  assert.equal(first.retry_at, now + 30000);

  ledger.close();
  ledger = new Ledger(path, 1000000, 1000000, 1000000);
  await recoverChannels(recoveryOptions(ledger, wallet, request), now + 29999);
  assert.equal(requests, 1, 'a restart must not erase retry backoff');
  await recoverChannels(recoveryOptions(ledger, wallet, request), now + 30000);
  assert.equal(requests, 2, 'the unchanged authorization is replayed once backoff expires');
});

test('channel recovery processes at most two due bundles per reconciliation pass', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'delphi-channel-bounded-'));
  const ledger = new Ledger(join(dir, 'ledger.sqlite'), 1000000, 1000000, 1000000);
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  for (let index = 0; index < 5; index++) {
    storeBundle(ledger, recoverableBundle(`${'c'.repeat(63)}${index}`, Keypair.generate().publicKey.toBase58()));
  }
  let requests = 0;
  const request = (async () => {
    requests++;
    return Response.json({ error: 'pending' }, { status: 503 });
  }) as typeof fetch;
  await recoverChannels(recoveryOptions(ledger, Keypair.generate(), request), 2000000);
  assert.equal(requests, 2);
});

test('a fabricated zero-delivery receipt cannot free missing-read budget', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'delphi-channel-zero-'));
  const ledger = new Ledger(join(dir, 'ledger.sqlite'), 1000000, 1000000, 1000000);
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  const wallet = Keypair.generate();
  const bundle = recoverableBundle('e'.repeat(64), Keypair.generate().publicKey.toBase58());
  bundle.value = { id: bundle.id, amount: '0', forecasts: [] };
  bundle.header = Buffer.from(JSON.stringify({
    success: true,
    network: DEVNET,
    payer: wallet.publicKey.toBase58(),
    amount: '0',
    transaction: '2'.repeat(64),
  })).toString('base64');
  storeBundle(ledger, bundle);

  const noRequest = (async () => { throw new Error('a persisted response must not be replayed'); }) as typeof fetch;
  await recoverChannels(recoveryOptions(ledger, wallet, noRequest), 3000000);
  for (const item of bundle.items) assert.equal(ledger.has('read', item.listing.forecastPda), true);
  const row = ledger.db.prepare('SELECT state,last_error FROM bundles WHERE id=?').get(bundle.id) as { state: string; last_error: string };
  assert.equal(row.state, 'reserved');
  assert.match(row.last_error, /reservations retained/);
});
