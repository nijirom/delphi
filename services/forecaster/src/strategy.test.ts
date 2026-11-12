import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecast, slugs } from './strategy.js';
import { openStore, persist, find } from './store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('mechanical strategies are bounded and deterministic', () => {
  assert.equal(forecast('contrarian', 0.8, null).probBps, 7400);
  assert.equal(forecast('momentum', 0.8, 0.6).probBps, 8500);
  assert.equal(forecast('momentum', 0.8, null).probBps, 8000);
  for (const slug of slugs) for (const p of [0.001, 0.5, 0.999]) {
    const result = forecast(slug, p, 0.5);
    assert.ok(result.probBps >= 100 && result.probBps <= 9900);
  }
  assert.throws(() => forecast('sharp', NaN, null));
});
test('reveal survives reopen and cannot be replaced on retry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delphi-store-'));
  const path = join(dir, 'forecaster.sqlite');
  try {
    let db = openStore(path);
    const row = { forecast_pda: 'pda', persona: 'sharp', event_ticker: 'ticker', instrument_symbol: 'symbol', prob_bps: 5000, salt_hex: 'ab'.repeat(32), rationale: 'mechanical', posted_at: 1, tx: null };
    persist(db, row);
    assert.throws(() => persist(db, { ...row, prob_bps: 6000 }));
    db.close();
    db = openStore(path, true);
    assert.deepEqual(find(db, 'pda'), row);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
