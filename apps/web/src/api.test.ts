import assert from 'node:assert/strict';
import test from 'node:test';
import type { MarketDetail } from '@delphi/shared';
import { isDetail } from './api.js';

test('market responses reject malformed nested chart and forecast values before rendering', () => {
  const detail: MarketDetail = {
    instrumentSymbol: 'GEMI-TEST-UP', marketPda: 'market', eventTicker: 'TEST', title: 'Test market', category: 'Crypto',
    expiryDate: null, geminiStatus: 'active', resolved: false, outcomeYes: null, resolvedAt: null,
    quote: { bestBid: 0.4, bestAsk: 0.6, lastTradePrice: null, mid: 0.5 }, quoteUpdatedAt: 1794544000000,
    forecasts: 1, revealed: 0, reads: 0, latestDecision: null,
    prices: [{ ts: 1794544000000, bid: 0.4, ask: 0.6, mid: 0.5 }],
    forecastList: [{ forecastPda: 'forecast', forecasterPda: 'forecaster', forecasterName: 'sharp', reputationBps: 5000, pricePerReadUsdc: 0.01, reads: 0, postedAt: 1794544000000, revealed: false, probBps: null, brierBps: null }],
  };
  assert.equal(isDetail(detail), true);
  assert.equal(isDetail({ ...detail, prices: [null] }), false);
  assert.equal(isDetail({ ...detail, prices: [{ ...detail.prices[0], mid: 3 }] }), false);
  assert.equal(isDetail({ ...detail, forecastList: [{ ...detail.forecastList[0], pricePerReadUsdc: '0.01' }] }), false);
  assert.equal(isDetail({ ...detail, forecastList: [{ ...detail.forecastList[0], revealed: true, probBps: null }] }), false);
  assert.equal(isDetail({ ...detail, latestDecision: { stage: 'decide', ts: 1794544000000, detail: null } }), false);
});
