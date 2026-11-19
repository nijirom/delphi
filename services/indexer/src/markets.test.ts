import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { GeminiClient, type AgentTelemetry, type GeminiEvent } from '@delphi/shared';
import { ChainIndexer } from './chain.js';
import { Markets } from './markets.js';
import { Store } from './store.js';

test('market decision follows the latest stage without carrying sizing across buyer scans', () => {
  const store = new Store(':memory:');
  try {
    const chain = new ChainIndexer(store, new PublicKey('EVqrBtTWaQiwnrhXzDgqr5TML6oDpHqHs5jjeLLg42Qc'), 'http://127.0.0.1:8899', fileURLToPath(new URL('../../../packages/shared/idl/delphi.json', import.meta.url)), '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', () => {});
    chain.symbols.set('market', 'GEMI-TEST-UP');
    const markets = new Markets(store, chain, new GeminiClient({ publicBase: 'https://api.gemini.com', privateBase: 'https://api.sandbox.gemini.com' }));
    let ts = 1000;
    const emit = (stage: AgentTelemetry['stage'], detail: Record<string, unknown>, symbol = 'GEMI-TEST-UP') => store.addTelemetry({ ts: ts++, stage, detail, ...(stage === 'scan' ? {} : { instrumentSymbol: symbol }) });
    emit('scan', {});
    emit('aggregate', { probability: 0.7 });
    emit('decide', { side: 'yes', edge: 0.1, reservedUsdc: 0.2 });
    emit('aggregate', { probability: 0.1 }, 'GEMI-OTHER-UP');
    emit('trade', { orderId: 'order', status: 'filled' });
    let decision = markets.detail('GEMI-TEST-UP')!.latestDecision!;
    assert.equal(decision.stage, 'trade');
    assert.equal(decision.detail.probability, 0.7);
    assert.equal(decision.detail.reservedUsdc, 0.2);
    emit('scan', {});
    emit('skip', { reason: 'dry_run_no_payments_or_trades' });
    decision = markets.detail('GEMI-TEST-UP')!.latestDecision!;
    assert.equal(decision.stage, 'skip');
    assert.equal(decision.detail.reason, 'dry_run_no_payments_or_trades');
    assert.equal(decision.detail.probability, undefined);
    assert.equal(decision.detail.reservedUsdc, undefined);
    emit('error', { status: 'blocked' });
    assert.equal(markets.detail('GEMI-TEST-UP')!.latestDecision!.stage, 'error');
  } finally { store.db.close(); }
});

function activeEvent(ticker: string, symbols: string[]): GeminiEvent {
  return {
    id: ticker, ticker, title: ticker, category: 'crypto', type: 'binary', status: 'active', resolvedAt: null, expiryDate: null,
    contracts: symbols.map(instrumentSymbol => ({
      id: instrumentSymbol, ticker: instrumentSymbol, instrumentSymbol, label: instrumentSymbol, status: 'active', resolutionSide: null, resolvedAt: null, expiryDate: null,
      prices: { buy: { yes: '0.6', no: '0.6' }, sell: { yes: '0.4', no: '0.4' }, bestBid: '0.4', bestAsk: '0.6', lastTradePrice: null },
    })),
  };
}

test('known event refresh samples sibling contracts together without scanning the catalog', async t => {
  const store = new Store(':memory:');
  try {
    let now = 1000000;
    t.mock.method(Date, 'now', () => now);
    const chain = new ChainIndexer(store, new PublicKey('EVqrBtTWaQiwnrhXzDgqr5TML6oDpHqHs5jjeLLg42Qc'), 'http://127.0.0.1:8899', fileURLToPath(new URL('../../../packages/shared/idl/delphi.json', import.meta.url)), '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', () => {});
    chain.symbols.set('up', 'GEMI-TEST-UP');
    chain.symbols.set('down', 'GEMI-TEST-DOWN');
    chain.symbols.set('team', 'GEMI-NBA-TEAM-M-A');
    const gemini = new GeminiClient({ publicBase: 'https://api.gemini.com', privateBase: 'https://api.sandbox.gemini.com' });
    const requested: string[] = [];
    t.mock.method(gemini, 'listEvents', async () => { throw new Error('Unexpected catalog scan'); });
    t.mock.method(gemini, 'getEvent', async (ticker: string) => {
      requested.push(ticker);
      if (ticker === 'TEST') return activeEvent(ticker, ['GEMI-TEST-UP', 'GEMI-TEST-DOWN', 'GEMI-UNKNOWN-UP']);
      if (ticker === 'NBA-TEAM-M') return activeEvent(ticker, ['GEMI-NBA-TEAM-M-A']);
      throw new Error('Unexpected event ticker');
    });
    const markets = new Markets(store, chain, gemini);
    assert.equal(markets.detail('GEMI-TEST-UP')!.quoteUpdatedAt, null);
    await markets.refresh();
    assert.deepEqual(requested, ['TEST', 'NBA-TEAM-M']);
    for (const symbol of chain.symbols.values()) {
      const detail = markets.detail(symbol)!;
      assert.equal(detail.quoteUpdatedAt, now);
      assert.deepEqual(detail.prices, [{ ts: now, bid: 0.4, ask: 0.6, mid: 0.5 }]);
    }
    assert.deepEqual(store.db.prepare('SELECT DISTINCT symbol FROM prices ORDER BY symbol').all(), [
      { symbol: 'GEMI-NBA-TEAM-M-A' }, { symbol: 'GEMI-TEST-DOWN' }, { symbol: 'GEMI-TEST-UP' },
    ]);
    now += 1000;
    await markets.refresh();
    assert.deepEqual(markets.detail('GEMI-TEST-UP')!.prices.map(p => p.ts), [1000000, 1001000]);
    chain.symbols.clear();
    assert.deepEqual(markets.categories(), []);
    now += 8 * 86400000;
    await markets.refresh();
    assert.deepEqual(store.db.prepare('SELECT * FROM prices').all(), []);
  } finally { store.db.close(); }
});

test('failed and missing contract refreshes retain quote age and history without blocking other events', async t => {
  const store = new Store(':memory:');
  try {
    let now = 1000000, fail = false, missing = false;
    t.mock.method(Date, 'now', () => now);
    const chain = new ChainIndexer(store, new PublicKey('EVqrBtTWaQiwnrhXzDgqr5TML6oDpHqHs5jjeLLg42Qc'), 'http://127.0.0.1:8899', fileURLToPath(new URL('../../../packages/shared/idl/delphi.json', import.meta.url)), '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', () => {});
    chain.symbols.set('market', 'GEMI-TEST-UP');
    chain.symbols.set('other', 'GEMI-OTHER-UP');
    const gemini = new GeminiClient({ publicBase: 'https://api.gemini.com', privateBase: 'https://api.sandbox.gemini.com' });
    let attempts = 0;
    t.mock.method(gemini, 'listEvents', async () => { throw new Error('Unexpected catalog scan'); });
    t.mock.method(gemini, 'getEvent', async (ticker: string) => {
      if (ticker === 'TEST') {
        attempts++;
        if (fail) throw new Error('Gemini unavailable');
        if (missing) return activeEvent(ticker, []);
      }
      return activeEvent(ticker, [`GEMI-${ticker}-UP`]);
    });
    const markets = new Markets(store, chain, gemini);
    await markets.refresh();
    const initial = markets.detail('GEMI-TEST-UP')!;
    fail = true;
    now += 1000;
    await markets.refresh();
    const failed = markets.detail('GEMI-TEST-UP')!;
    assert.equal(failed.quoteUpdatedAt, initial.quoteUpdatedAt);
    assert.deepEqual(failed.quote, initial.quote);
    assert.deepEqual(failed.prices, initial.prices);
    assert.equal(markets.detail('GEMI-OTHER-UP')!.quoteUpdatedAt, now);
    assert.deepEqual(markets.detail('GEMI-OTHER-UP')!.prices.map(p => p.ts), [1000000, 1001000]);
    fail = false;
    now += 1000;
    await markets.refresh();
    assert.equal(attempts, 2);
    assert.equal(markets.detail('GEMI-TEST-UP')!.quoteUpdatedAt, initial.quoteUpdatedAt);
    missing = true;
    now += 300000;
    await markets.refresh();
    assert.equal(markets.detail('GEMI-TEST-UP')!.quoteUpdatedAt, initial.quoteUpdatedAt);
    assert.deepEqual(markets.detail('GEMI-TEST-UP')!.prices, initial.prices);
    missing = false;
    now += 300000;
    await markets.refresh();
    assert.equal(markets.detail('GEMI-TEST-UP')!.quoteUpdatedAt, now);
    assert.deepEqual(markets.detail('GEMI-TEST-UP')!.prices.map(p => p.ts), [1000000, now]);
  } finally { store.db.close(); }
});

test('catalog backstop recovers symbols whose ticker convention the parser does not know, once per cooldown', async t => {
  const store = new Store(':memory:');
  try {
    let now = 1000000, scans = 0;
    t.mock.method(Date, 'now', () => now);
    const chain = new ChainIndexer(store, new PublicKey('EVqrBtTWaQiwnrhXzDgqr5TML6oDpHqHs5jjeLLg42Qc'), 'http://127.0.0.1:8899', fileURLToPath(new URL('../../../packages/shared/idl/delphi.json', import.meta.url)), '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', () => {});
    chain.symbols.set('odd', 'GEMI-ODDSHAPE');
    const gemini = new GeminiClient({ publicBase: 'https://api.gemini.com', privateBase: 'https://api.sandbox.gemini.com' });
    t.mock.method(gemini, 'getEvent', async () => { throw new Error('404'); });
    t.mock.method(gemini, 'listEvents', async () => { scans++; return { data: [activeEvent('WEIRD', ['GEMI-ODDSHAPE'])], pagination: { total: 1, limit: 100, offset: 0 } }; });
    const markets = new Markets(store, chain, gemini);
    await markets.refresh();
    assert.equal(scans, 1);
    assert.equal(markets.detail('GEMI-ODDSHAPE')!.eventTicker, 'WEIRD');
    assert.equal(markets.detail('GEMI-ODDSHAPE')!.quoteUpdatedAt, now);
    chain.symbols.set('odd2', 'GEMI-ODDSHAPE2');
    now += 1000;
    await markets.refresh();
    assert.equal(scans, 1, 'second unknown symbol waits for the cooldown');
    now += 300000;
    await markets.refresh();
    assert.equal(scans, 2);
  } finally { store.db.close(); }
});

test('cadence windows disambiguate identical event titles and uncached historical symbols receive fallback metadata', async t => {
  const store = new Store(':memory:');
  try {
    const chain = new ChainIndexer(store, new PublicKey('EVqrBtTWaQiwnrhXzDgqr5TML6oDpHqHs5jjeLLg42Qc'), 'http://127.0.0.1:8899', fileURLToPath(new URL('../../../packages/shared/idl/delphi.json', import.meta.url)), '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', () => {});
    chain.symbols.set('eth5m', 'GEMI-ETH05M2611130530-UP');
    chain.symbols.set('eth15m', 'GEMI-ETH15M2611130530-UP');
    chain.symbols.set('hist', 'GEMI-BTC05M2611131905-UP');
    const gemini = new GeminiClient({ publicBase: 'https://api.gemini.com', privateBase: 'https://api.sandbox.gemini.com' });
    t.mock.method(gemini, 'listEvents', async () => ({ data: [], pagination: { total: 0, limit: 100, offset: 0 } }));
    t.mock.method(gemini, 'getEvent', async (ticker: string) => {
      if (ticker === 'ETH05M2611130530' || ticker === 'ETH15M2611130530') {
        const sym = `GEMI-${ticker}-UP`;
        return {
          ...activeEvent(ticker, [sym]),
          title: 'ETH price today at 12:30am EST',
          category: 'Crypto',
          contracts: [{ ...activeEvent(ticker, [sym]).contracts[0]!, label: 'Up' }],
        };
      }
      throw new Error('Historical event expired');
    });
    const markets = new Markets(store, chain, gemini);
    const uncached = markets.detail('GEMI-BTC05M2611131905-UP')!;
    assert.equal(uncached.category, 'Crypto');
    assert.equal(uncached.expiryDate, '2026-11-13T19:05:00.000Z');
    assert.equal(uncached.eventTicker, 'BTC05M2611131905');
    assert.ok(uncached.title?.includes('BTC 5m'));
    await markets.refresh();
    assert.equal(markets.detail('GEMI-ETH05M2611130530-UP')!.title, 'ETH price today at 12:30am EST · 5m');
    assert.equal(markets.detail('GEMI-ETH15M2611130530-UP')!.title, 'ETH price today at 12:30am EST · 15m');
  } finally { store.db.close(); }
});
