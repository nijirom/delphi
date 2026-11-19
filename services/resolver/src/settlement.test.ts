import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { REVEAL_WINDOW_SECS, type ForecastAccount, type GeminiContract, type GeminiEvent } from '@delphi/shared';
import { forfeitSweep, resolveSettled, type MarketRow } from './settlement.js';

const isStopping = () => false;
const key = (id: number) => new PublicKey(new Uint8Array(32).fill(id));
function market(id: number, symbol: string, resolved = false, resolvedAt = 100): MarketRow {
  return { pubkey: key(id), account: { marketHash: new Uint8Array(32), instrumentSymbol: symbol, resolved, outcomeYes: false, resolvedAt } };
}
function contract(symbol: string, status = 'settled', resolutionSide: GeminiContract['resolutionSide'] = 'yes'): GeminiContract {
  return {
    id: symbol, ticker: symbol, instrumentSymbol: symbol, label: symbol, status, resolutionSide, resolvedAt: null, expiryDate: null,
    prices: { buy: { yes: '0.5', no: '0.5' }, sell: { yes: '0.5', no: '0.5' }, bestBid: null, bestAsk: null, lastTradePrice: null },
  };
}
function event(ticker: string, contracts: GeminiContract[]): GeminiEvent {
  return { id: ticker, ticker, title: ticker, category: 'crypto', type: 'binary', status: 'settled', resolvedAt: null, expiryDate: null, contracts };
}
function settlementClient(markets: MarketRow[]) {
  return {
    async resolveMarket(symbol: string, outcome: boolean) {
      const row = markets.find(m => m.account.instrumentSymbol === symbol);
      assert.ok(row, 'cannot resolve a market outside the on-chain enumeration');
      row.account.resolved = true;
      row.account.outcomeYes = outcome;
      row.account.resolvedAt = 1000;
      return 'resolved';
    },
    async fetchMarket(symbol: string) { return markets.find(m => m.account.instrumentSymbol === symbol)?.account ?? null; },
  };
}
function forecast(id: number, market: PublicKey): { pubkey: PublicKey; account: ForecastAccount } {
  return { pubkey: key(id), account: { forecaster: key(99), market, commitment: new Uint8Array(32), pricePerRead: 1n, postedAt: 0, reads: 0, revealed: false, forfeited: false, probBps: 0, brierBps: 0 } };
}

test('old pending markets absent from the recent feed resolve from one exact event lookup for sibling contracts', async () => {
  const markets = [market(1, 'GEMI-OLD-UP'), market(2, 'GEMI-OLD-DOWN'), market(3, 'GEMI-RECENT-UP')];
  const requested: string[] = [];
  const failures = await resolveSettled(markets, {
    client: settlementClient(markets), isStopping,
    gemini: {
      async recentlySettled() { return { data: [event('RECENT', [contract('GEMI-RECENT-UP')])] }; },
      async getEvent(ticker: string) {
        requested.push(ticker);
        return event('OLD', [contract('GEMI-OLD-UP'), contract('GEMI-OLD-DOWN', 'resolved', 'no')]);
      },
    },
  });
  assert.equal(failures, 0);
  assert.deepEqual(markets.map(m => [m.account.resolved, m.account.outcomeYes]), [[true, true], [true, false], [true, true]]);
  assert.deepEqual(requested, ['OLD']);
});

test('direct settlement requires an exact symbol, terminal contract status, yes/no outcome, and the requested event', async () => {
  const markets = [
    market(1, 'GEMI-OLD-ACTIVE'), market(2, 'GEMI-OLD-UNKNOWN'), market(3, 'GEMI-OLD-MISSING'),
    market(4, 'GEMI-OLD-VALID'), market(5, 'GEMI-WRONG-UP'),
  ];
  const failures = await resolveSettled(markets, {
    client: settlementClient(markets), isStopping,
    gemini: {
      async recentlySettled() { return { data: [] }; },
      async getEvent(ticker: string) {
        if (ticker === 'WRONG') return event('DIFFERENT', [contract('GEMI-WRONG-UP')]);
        return event('OLD', [
          contract('GEMI-OLD-ACTIVE', 'active'), contract('GEMI-OLD-UNKNOWN', 'settled', null),
          contract('GEMI-OTHER-MISSING'), contract('GEMI-OLD-VALID', 'ReSoLvEd', 'no'),
        ]);
      },
    },
  });
  assert.equal(failures, 1, 'mismatched event data must keep the poll unhealthy');
  assert.deepEqual(markets.map(m => m.account.resolved), [false, false, false, true, false]);
  assert.equal(markets[3]!.account.outcomeYes, false);
});

test('feed and direct lookup failures remain unhealthy without blocking independent recovery or a protected chain-time sweep', async () => {
  const now = 100 + REVEAL_WINDOW_SECS + 1;
  const markets = [
    market(1, 'GEMI-FAILED-UP'), market(2, 'GEMI-OLD-UP'),
    market(3, 'GEMI-OVERDUE-UP', true), market(4, 'GEMI-INWINDOW-UP', true, now),
  ];
  const forecasts = [forecast(11, markets[2]!.pubkey), forecast(12, markets[2]!.pubkey), forecast(13, markets[3]!.pubkey), forecast(14, markets[0]!.pubkey)];
  const protect = new Set([forecasts[1]!.pubkey.toBase58()]);
  let failures = await resolveSettled(markets, {
    client: settlementClient(markets), isStopping,
    gemini: {
      async recentlySettled() { throw new Error('Recent feed unavailable'); },
      async getEvent(ticker: string) {
        if (ticker === 'FAILED') throw new Error('Event lookup unavailable');
        return event('OLD', [contract('GEMI-OLD-UP')]);
      },
    },
  });
  assert.equal(failures, 2);
  assert.equal(markets[0]!.account.resolved, false);
  assert.equal(markets[1]!.account.resolved, true);
  failures += await forfeitSweep(markets, protect, {
    isStopping, chainTime: async () => now,
    client: {
      async unscoredForecasts() { return forecasts; },
      async forfeitForecast(address: PublicKey) {
        forecasts.find(f => f.pubkey.equals(address))!.account.forfeited = true;
        return 'forfeited';
      },
      async fetchForecast(address: PublicKey) { return forecasts.find(f => f.pubkey.equals(address))?.account ?? null; },
    },
  });
  assert.equal(failures, 2, 'settlement failures must not be erased by a successful sweep');
  assert.deepEqual(forecasts.map(f => f.account.forfeited), [true, false, false, false]);
});

test('forfeit send races are successful only when the chain confirms a revealed or forfeited terminal state', async () => {
  const row = market(1, 'GEMI-OVERDUE-UP', true);
  const forecasts = [forecast(11, row.pubkey), forecast(12, row.pubkey), forecast(13, row.pubkey), forecast(14, row.pubkey), forecast(15, row.pubkey)];
  const attempted: string[] = [];
  const failures = await forfeitSweep([row], new Set(), {
    isStopping, chainTime: async () => 100 + REVEAL_WINDOW_SECS + 1,
    client: {
      async unscoredForecasts() { return forecasts; },
      async forfeitForecast(address: PublicKey) {
        attempted.push(address.toBase58());
        if (address.equals(forecasts[0]!.pubkey)) forecasts[0]!.account.revealed = true;
        if (address.equals(forecasts[1]!.pubkey)) forecasts[1]!.account.forfeited = true;
        throw new Error('Transaction lost the race or failed');
      },
      async fetchForecast(address: PublicKey) {
        if (address.equals(forecasts[3]!.pubkey)) return null;
        if (address.equals(forecasts[4]!.pubkey)) throw new Error('RPC unavailable');
        return forecasts.find(f => f.pubkey.equals(address))!.account;
      },
    },
  });
  assert.deepEqual(attempted, forecasts.map(f => f.pubkey.toBase58()));
  assert.equal(failures, 3, 'only still-open, missing, or unreadable forecasts count as failures');
});
