import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorized, eventKind, normalizePayload, telemetry, tokenReceipts, type Row } from './input.js';
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
    const entries = [{ kind: 'purchase_recorded', data: { amount: '999999999' } }, { kind: 'usdc_transfer', data: { owner: 'owner', amountBaseUnits: '10000' } }];
    assert.equal(db.ingest(row(), entries).length, 2);
    assert.equal(db.ingest(row(), entries).length, 0);
    db.snapshot([{ authority: 'owner', forecasterPda: 'pda', name: 'name', reputationBps: 5000, scoredCount: 0, totalReads: 7 }]);
    assert.equal(db.leaderboard()[0]?.earnedUsdc, 0.01);
    assert.equal(db.leaderboard()[0]?.totalReads, 7);
    assert.equal(db.events(100, 0).length, 2);
    db.set('rpcCursor', row().signature); assert.equal(db.get('rpcCursor'), row().signature);
  } finally { db.db.close(); }
});
test('telemetry validates stages and rejects sensitive structured fields', () => {
  assert.equal(telemetry({ ts: 1, stage: 'scan', detail: { contracts: 2 } }).stage, 'scan');
  assert.throws(() => telemetry({ ts: 1, stage: 'unknown', detail: {} }));
  assert.throws(() => telemetry({ ts: 1, stage: 'buy', detail: { nested: { apiKey: 'credential' } } }));
});
