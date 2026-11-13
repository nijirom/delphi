import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { brierBps, clampProb, edge, kellyFraction, pooledForecast } from './math.js';
import { commitment, marketHash } from './solana.js';
import { eventTickerFromSymbol, midPrice, type GeminiContract } from './gemini.js';
test('Brier mirrors integer program scoring', () => {
  assert.equal(brierBps(10000, true), 0); assert.equal(brierBps(0, true), 10000);
  assert.equal(brierBps(5000, false), 2500); assert.equal(brierBps(3333, true), 4444);
  assert.throws(() => brierBps(10001, true));
});
test('pooling and guardrail arithmetic', () => {
  assert.ok(Number.isNaN(pooledForecast([]).prob));
  assert.equal(pooledForecast([{ prob: 0.5, reputationBps: 5000 }]).prob, 0.5);
  assert.ok(Math.abs(pooledForecast([{ prob: 0.2, reputationBps: 8000 }, { prob: 0.8, reputationBps: 8000 }]).prob - 0.5) < 1e-12);
  assert.equal(clampProb(1), 0.99); assert.throws(() => clampProb(NaN));
  assert.equal(edge(0.3, 0.5).side, 'no'); assert.equal(kellyFraction(0.9, 0.5, 0.25), 0.25);
  assert.equal(kellyFraction(0.1, 0.5, 0.25), 0);
});
test('commitments use two-byte little endian probability', () => {
  const salt = new Uint8Array(32); const input = Buffer.alloc(34); input.writeUInt16LE(7500);
  assert.deepEqual(Buffer.from(commitment(7500, salt)), createHash('sha256').update(input).digest());
  assert.throws(() => commitment(7500, new Uint8Array(31)));
  assert.deepEqual(Buffer.from(marketHash('abc')), createHash('sha256').update('abc').digest());
});
test('market quote parsing rejects empty and nonfinite quotes', () => {
  const quote = (bid: string | null, ask: string | null, last: string | null) => ({ prices: { bestBid: bid, bestAsk: ask, lastTradePrice: last } }) as GeminiContract;
  assert.equal(midPrice(quote('0.4', '0.6', null)), 0.5);
  assert.equal(midPrice(quote('', 'Infinity', null)), null);
  assert.equal(midPrice(quote(null, null, '0.3')), 0.3);
  assert.equal(midPrice(quote('0.8', '0.2', null)), null);
  assert.equal(eventTickerFromSymbol('GEMI-BTC05M2611122100-UP'), 'BTC05M2611122100');
  assert.equal(eventTickerFromSymbol('GEMI-HYPE2611132200-HI68'), 'HYPE2611132200');
  assert.equal(eventTickerFromSymbol('GEMI-NBA-2611160000-HOU-WAS-M-HOU'), 'NBA-2611160000-HOU-WAS-M');
  assert.equal(eventTickerFromSymbol('GEMI-SOLO'), 'SOLO');
});
