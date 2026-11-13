import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecast, slugs } from './strategy.js';
import { SignalCache } from './signal.js';
import type { GeminiClient, GeminiContract, GeminiEvent } from '@delphi/shared';
import { openStore, persist, find } from './store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('baseline strategies are bounded; quant abstains without a signal and ignores the market mid with one', () => {
  assert.equal(forecast('contrarian', 0.8, null, null)!.probBps, 7400);
  assert.equal(forecast('momentum', 0.8, 0.6, null)!.probBps, 8500);
  assert.equal(forecast('momentum', 0.8, null, null)!.probBps, 8000);
  assert.equal(forecast('quant', 0.8, null, null), null);
  const signal = { spot: 101, strike: 100, sigmaPerMinute: 0.001, minutes: 5, spotSymbol: 'btcusd', volWindow: 240 };
  const a = forecast('quant', 0.05, null, signal)!, b = forecast('quant', 0.95, null, signal)!;
  assert.equal(a.probBps, b.probBps, 'quant does not depend on the market mid');
  assert.ok(a.probBps >= 9800, `spot above strike with low vol should be near certain, got ${a.probBps}`);
  assert.ok(forecast('quant', 0.5, null, { ...signal, spot: 99 })!.probBps <= 200);
  assert.match(a.rationale, /Ignores the market price/);
  for (const slug of slugs) for (const p of [0.001, 0.5, 0.999]) {
    const result = forecast(slug, p, 0.5, signal);
    assert.ok(result && result.probBps >= 100 && result.probBps <= 9900);
  }
  assert.throws(() => forecast('momentum', NaN, null, null));
});
test('signal cache maps settlement index to a spot feed, waits for reference strikes, and fetches each feed once', async () => {
  const calls: string[] = [];
  const gemini = {
    spot: async (s: string) => { calls.push(`spot:${s}`); return 100; },
    minuteCloses: async (s: string) => { calls.push(`candles:${s}`); return Array.from({ length: 300 }, (_, i) => 100 + (i % 2)); },
  } as unknown as GeminiClient;
  const now = Date.parse('2026-11-13T05:45:00.000Z');
  const cache = new SignalCache(gemini, () => now);
  const event = (index: string | undefined): GeminiEvent => ({ id: 'e', title: 'e', ticker: 'e', category: 'Crypto', type: 'binary', status: 'active', resolvedAt: null, expiryDate: '2026-11-13T05:50:00.000Z', contracts: [], sourceDetails: index ? { agency: 'lukka', index } : undefined });
  const contract = (strike: GeminiContract['strike']): GeminiContract => ({ id: 'c', label: 'c', ticker: 'c', instrumentSymbol: 'GEMI-C', status: 'active', resolutionSide: null, resolvedAt: null, expiryDate: null, prices: { buy: { yes: '0.5', no: '0.5' }, sell: { yes: '0.5', no: '0.5' }, bestBid: '0.4', bestAsk: '0.6', lastTradePrice: null }, strike });
  assert.equal(await cache.for(event('LS-LRRR-XBTUSD'), contract({ type: 'reference', availableAt: '2026-11-13T05:45:00.000Z' })), null, 'reference strike not yet published');
  assert.equal(await cache.for(event(undefined), contract({ type: 'above', value: '100' })), null, 'no settlement index');
  assert.equal(await cache.for(event('LS-LRRR-NOPE'), contract({ type: 'above', value: '100' })), null, 'unmapped index');
  assert.deepEqual(calls, []);
  const first = await cache.for(event('LS-LRRR-XBTUSD'), contract({ type: 'above', value: '99' }));
  const second = await cache.for(event('LS-LRRR-XBTUSD'), contract({ type: 'reference', value: '101' }));
  assert.equal(first!.spot, 100); assert.equal(first!.strike, 99); assert.equal(first!.minutes, 5); assert.equal(first!.volWindow, 240);
  assert.equal(second!.strike, 101);
  assert.ok(first!.sigmaPerMinute > 0.009 && first!.sigmaPerMinute < 0.011);
  assert.deepEqual(calls.sort(), ['candles:btcusd', 'spot:btcusd'], 'one feed fetch serves both contracts');
});
test('reveal survives reopen and cannot be replaced on retry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delphi-store-'));
  const path = join(dir, 'forecaster.sqlite');
  try {
    let db = openStore(path);
    const row = { forecast_pda: 'pda', persona: 'quant', event_ticker: 'ticker', instrument_symbol: 'symbol', prob_bps: 5000, salt_hex: 'ab'.repeat(32), rationale: 'mechanical', posted_at: 1, tx: null };
    persist(db, row);
    assert.throws(() => persist(db, { ...row, prob_bps: 6000 }));
    db.close();
    db = openStore(path, true);
    assert.deepEqual(find(db, 'pda'), row);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
