import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { authorized, eventKind, normalizePayload, quicknodeSignatureValid, streamsDeliveryState, telemetry, tokenReceipts, type Row } from './input.js';
import { usdcTransferEvents } from './chain.js';
import { Store } from './store.js';
const row = (): Row => ({ signature: '1'.repeat(88), slot: 10, blockTime: 100, logMessages: [], err: null, accountKeys: [], preTokenBalances: [], postTokenBalances: [] });
test('authentication fails closed and does not accept default credentials', () => {
  assert.equal(authorized('', ''), false); assert.equal(authorized('change-me', 'change-me'), false);
  assert.equal(authorized('configured-secret', 'configured-secret'), true);
  assert.equal(authorized('configured-secret', ['configured-secret']), false);
  assert.equal(authorized('configured-secret', 'wrong'), false);
});
test('filtered and block transaction envelopes normalize identically', () => {
  const r = row();
  assert.deepEqual(normalizePayload({ data: [r] }), [r]);
  assert.deepEqual(normalizePayload([{ slot: 10, blockTime: 100, transactions: [{ transaction: { signatures: [r.signature], message: { accountKeys: [] } }, meta: { err: null, logMessages: [], preTokenBalances: [], postTokenBalances: [] } }] }]), [r]);
  assert.throws(() => normalizePayload({}));
  assert.throws(() => normalizePayload([{ ...r, err: undefined, logMessages: 'invalid' }]));
  const { err: _err, ...missingError } = r;
  assert.throws(() => normalizePayload(missingError));
});
test('Anchor event name normalization', () => {
  assert.equal(eventKind('ForecastPosted'), 'forecast_posted');
  assert.equal(eventKind('forecast_posted'), 'forecast_posted');
  assert.equal(eventKind('forecastScored'), 'forecast_scored');
  assert.equal(eventKind('arbitrary'), undefined);
});
test('receipts count only actual positive mint deltas of known owners', () => {
  const r = row();
  const b = (amount: string, mint = 'usdc', owner = 'forecaster') => ({ accountIndex: 1, mint, owner, uiTokenAmount: { amount, decimals: 6 } });
  r.preTokenBalances = [b('1000000')];
  r.postTokenBalances = [b('1010000'), b('999999', 'other'), b('999999', 'usdc', 'buyer')];
  assert.deepEqual(tokenReceipts(r, 'usdc', new Set(['forecaster'])), [{ owner: 'forecaster', amount: 10000n }]);
  r.postTokenBalances = [b('900000')];
  assert.deepEqual(tokenReceipts(r, 'usdc', new Set(['forecaster'])), []);
});
test('transaction dedup survives database operations and chain snapshots never increment reads', () => {
  const db = new Store(':memory:');
  try {
    const entries = [{ kind: 'purchase_recorded', data: { amount: '999999999' } }, { kind: 'usdc_transfer', data: { owner: 'owner', amountBaseUnits: '10000', earned: true } }];
    assert.equal(db.ingest(row(), entries).length, 2);
    assert.equal(db.ingest(row(), entries).length, 0);
    db.snapshot([{ authority: 'owner', forecasterPda: 'pda', name: 'name', reputationBps: 5000, scoredCount: 0, totalReads: 7 }]);
    assert.equal(db.leaderboard()[0]?.earnedUsdc, 0.01);
    assert.equal(db.leaderboard()[0]?.totalReads, 7);
    assert.equal(db.events(100, 0).length, 2);
    db.set('rpcCursor', row().signature); assert.equal(db.get('rpcCursor'), row().signature);
  } finally { db.db.close(); }
});
test('only a matching same-transaction purchase can turn an incoming transfer into earnings', () => {
  const receipt = [{ owner: 'owner', amount: 10000n }];
  const owners = new Map([['forecaster-pda', 'owner']]);
  const direct = usdcTransferEvents(receipt, [], owners, 'usdc')[0]!;
  const refund = usdcTransferEvents(receipt, [{ kind: 'purchase_recorded', data: { forecaster: 'forecaster-pda', amount: '10000' } }], owners, 'usdc', true)[0]!;
  const mismatched = usdcTransferEvents(receipt, [{ kind: 'purchase_recorded', data: { forecaster: 'forecaster-pda', amount: '9000' } }], owners, 'usdc')[0]!;
  const purchase = usdcTransferEvents(receipt, [{ kind: 'purchase_recorded', data: { forecaster: 'forecaster-pda', amount: '10000' } }], owners, 'usdc')[0]!;
  assert.equal(direct.data.earned, false);
  assert.equal(direct.data.attribution, 'unattributed_balance_increase');
  assert.equal(refund.data.earned, false);
  assert.equal(mismatched.data.earned, false);
  assert.equal(purchase.data.earned, true);

  const db = new Store(':memory:');
  try {
    db.snapshot([{ authority: 'owner', forecasterPda: 'forecaster-pda', name: 'name', reputationBps: 5000, scoredCount: 0, totalReads: 0 }]);
    db.ingest({ ...row(), signature: 'direct-transfer' }, [direct]);
    db.ingest({ ...row(), signature: 'bond-refund' }, [refund]);
    assert.equal(db.leaderboard()[0]?.earnedUsdc, 0);
    assert.equal(db.events(10, 0, 'usdc_transfer').some(event => event.signature === 'direct-transfer'), true);
    db.ingest({ ...row(), signature: 'matched-purchase' }, [purchase]);
    assert.equal(db.leaderboard()[0]?.earnedUsdc, 0.01);
  } finally { db.db.close(); }
});
test('leaderboard ranks scored forecasters ahead of unscored 5000-prior forecasters', () => {
  const db = new Store(':memory:');
  try {
    db.snapshot([
      { authority: 'unscored-owner', forecasterPda: 'unscored-pda', name: 'Unscored', reputationBps: 5000, scoredCount: 0, totalReads: 10 },
      { authority: 'scored-lower', forecasterPda: 'scored-lower-pda', name: 'ScoredLower', reputationBps: 4200, scoredCount: 3, totalReads: 5 },
      { authority: 'scored-higher', forecasterPda: 'scored-higher-pda', name: 'ScoredHigher', reputationBps: 4800, scoredCount: 1, totalReads: 2 },
    ]);
    assert.deepEqual(db.leaderboard().map(r => r.forecasterPda), ['scored-higher-pda', 'scored-lower-pda', 'unscored-pda']);
  } finally { db.db.close(); }
});
test('telemetry validates stages and rejects sensitive structured fields', () => {
  assert.equal(telemetry({ ts: 1, stage: 'scan', detail: { contracts: 2 } }).stage, 'scan');
  assert.throws(() => telemetry({ ts: 1, stage: 'unknown', detail: {} }));
  assert.throws(() => telemetry({ ts: 1, stage: 'buy', detail: { nested: { apiKey: 'credential' } } }));
});

test('market history survives unrelated global activity and applies filters before limits', () => {
  const store = new Store(':memory:');
  try {
    const symbol = 'GEMI-OLDER-UP';
    const purchase = store.ingest({ ...row(), signature: 'older-purchase' }, [
      { kind: 'purchase_recorded', data: { instrumentSymbol: symbol, amount: '10000' } },
    ])[0];
    const score = store.ingest({ ...row(), signature: 'older-score' }, [
      { kind: 'forecast_scored', data: { instrumentSymbol: symbol, brierBps: 900 } },
    ])[0];
    const decision = { ts: 100, stage: 'trade', instrumentSymbol: symbol, detail: { orderId: 42 } };
    store.addTelemetry(decision);
    for (let i = 0; i < 350; i++) {
      store.ingest({ ...row(), signature: `unrelated-${i}` }, [
        { kind: 'forecast_posted', data: { instrumentSymbol: 'GEMI-OTHER-UP' } },
      ]);
      store.addTelemetry({ ts: 200 + i, stage: 'skip', instrumentSymbol: 'GEMI-OTHER-UP', detail: {} });
    }
    assert.deepEqual(store.events(300, 0, undefined, symbol).map(e => e.id), [score.id, purchase.id]);
    assert.deepEqual(store.events(1, 0, 'purchase_recorded', symbol).map(e => e.id), [purchase.id]);
    assert.deepEqual(store.events(300, purchase.id, undefined, symbol).map(e => e.id), [score.id]);
    assert.deepEqual(store.events(300, 0, undefined, 'GEMI-NONE-UP'), []);
    assert.deepEqual(store.telemetry(300, symbol), [decision]);
  } finally { store.db.close(); }
});

test('QuickNode signed deliveries verify only with the right token, body and fresh timestamp', () => {
  const token = 'qn-security-token', body = '[{"slot":1}]', nonce = 'n-123', now = 1_800_000_000_000, ts = String(now / 1000);
  const sign = (b: string, t: string) => createHmac('sha256', token).update(nonce + t + b, 'utf8').digest('hex');
  assert.equal(quicknodeSignatureValid(token, body, nonce, ts, sign(body, ts), now), true);
  assert.equal(quicknodeSignatureValid(token, '[{"slot":2}]', nonce, ts, sign(body, ts), now), false, 'tampered body');
  assert.equal(quicknodeSignatureValid('other-token', body, nonce, ts, sign(body, ts), now), false, 'wrong token');
  const stale = String(now / 1000 - 301);
  assert.equal(quicknodeSignatureValid(token, body, nonce, stale, sign(body, stale), now), false, 'replayed outside the window');
  assert.equal(quicknodeSignatureValid('', body, nonce, ts, sign(body, ts), now), false, 'no token configured');
});

test('Streams delivery health distinguishes no delivery, current delivery and staleness', () => {
  assert.equal(streamsDeliveryState(0, null, 1_000_000), 'no_deliveries');
  assert.equal(streamsDeliveryState(1, 900_000, 1_000_000), 'receiving');
  assert.equal(streamsDeliveryState(1, 800_000, 1_000_000), 'stale');
});
