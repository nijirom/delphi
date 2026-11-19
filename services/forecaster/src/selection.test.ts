import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GeminiContract, GeminiEvent } from '@delphi/shared';
import { selectMarkets } from './selection.js';

const now = Date.parse('2026-11-19T20:00:00Z');
const at = (minutes: number) => new Date(now + minutes * 60000).toISOString();
function contract(symbol: string, mid: number | null, expiryMinutes: number | null, extra: Partial<GeminiContract> = {}): GeminiContract {
  const quote = mid === null ? null : String(mid);
  return {
    id: symbol, label: symbol, ticker: symbol, instrumentSymbol: symbol, status: 'active', resolutionSide: null, resolvedAt: null,
    expiryDate: expiryMinutes === null ? null : at(expiryMinutes),
    prices: { buy: { yes: quote, no: null }, sell: { yes: quote, no: null }, bestBid: quote, bestAsk: quote, lastTradePrice: null },
    quantityMinimum: '1', quantityIncrement: '1', priceIncrement: '0.01', priceMinimum: '0.01', ...extra,
  } as GeminiContract;
}
function event(ticker: string, category: string, contracts: GeminiContract[], extra: Partial<GeminiEvent> = {}): GeminiEvent {
  return { id: ticker, title: ticker, ticker, category, type: contracts.length > 1 ? 'categorical' : 'binary', status: 'active', resolvedAt: null, expiryDate: null, contracts, ...extra };
}
const symbols = (events: GeminiEvent[], count: number) => selectMarkets(events, now, count).map(c => c.contract.instrumentSymbol);

test('categories take turns in expiry order so short crypto contracts cannot fill every slot', () => {
  const events = [
    ...[5, 10, 15, 20].map(m => event(`BTC${m}`, 'Crypto', [contract(`BTC${m}`, 0.5, m)])),
    event('GAME', 'Sports', [contract('GAME-HOU', 0.5, 120), contract('GAME-LAL', 0.5, 120)]),
    event('GAME2', 'Sports', [contract('GAME2-A', 0.5, 180)]),
    event('SFO', 'Weather', [contract('SFO-56TO57', 0.5, 600)]),
  ];
  assert.deepEqual(symbols(events, 4), ['BTC5', 'GAME-HOU', 'SFO-56TO57', 'BTC10']);
  assert.deepEqual(symbols(events, 6), ['BTC5', 'GAME-HOU', 'SFO-56TO57', 'BTC10', 'GAME2-A', 'BTC15']);
});

test('a categorical event contributes only its most uncertain outcome', () => {
  const temps = event('SFO', 'Weather', [contract('SFO-52TO53', 0.1, 600), contract('SFO-54TO55', 0.42, 600), contract('SFO-56TO57', 0.7, 600)]);
  assert.deepEqual(symbols([temps], 6), ['SFO-54TO55']);
});

test('only active, unresolved, quoted contracts expiring between two minutes and one day qualify', () => {
  const events = [
    event('SOON', 'Crypto', [contract('SOON', 0.5, 1)]),
    event('LATE', 'Crypto', [contract('LATE', 0.5, 24 * 60 + 1)]),
    event('UNQUOTED', 'Crypto', [contract('UNQUOTED', null, 30)]),
    event('CERTAIN', 'Crypto', [contract('CERTAIN', 1, 30)]),
    event('SETTLED', 'Crypto', [contract('SETTLED', 0.5, 30, { resolutionSide: 'yes' })]),
    event('CLOSED', 'Crypto', [contract('CLOSED', 0.5, 30)], { status: 'closed' }),
    event('INHERITS', 'Crypto', [contract('INHERITS', 0.5, null)], { expiryDate: at(30) }),
  ];
  assert.deepEqual(symbols(events, 6), ['INHERITS']);
});
