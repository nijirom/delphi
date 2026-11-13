export type ForecastListing = { forecastPda: string; forecasterPda: string; forecasterAuthority: string; forecasterName: string; instrumentSymbol: string; pricePerReadUsdc: number; reputationBps: number; scoredCount: number; postedAt: number; url: string };
export type PaidForecast = { forecastPda: string; instrumentSymbol: string; probBps: number; salt: string; rationale: string; forecasterName: string; paymentSig?: string };
export type IndexerEvent = { id: number; slot: number; signature: string; ts: number; kind: 'forecast_posted' | 'purchase_recorded' | 'market_resolved' | 'forecast_scored' | 'usdc_transfer'; data: Record<string, unknown> };
export type LeaderboardRow = { forecasterPda: string; authority: string; name: string; reputationBps: number; scoredCount: number; totalReads: number; earnedUsdc: number };
export type AgentTelemetry = { ts: number; stage: 'scan' | 'buy' | 'aggregate' | 'decide' | 'approve' | 'trade' | 'skip' | 'error'; instrumentSymbol?: string; detail: Record<string, unknown> };

export type MarketQuote = { bestBid: number | null; bestAsk: number | null; lastTradePrice: number | null; mid: number | null };
export type MarketForecast = { forecastPda: string; forecasterPda: string; forecasterName: string; reputationBps: number; pricePerReadUsdc: number; reads: number; postedAt: number; revealed: boolean; probBps: number | null; brierBps: number | null };
export type MarketSummary = {
  instrumentSymbol: string; marketPda: string; eventTicker: string | null; title: string | null; category: string | null;
  expiryDate: string | null; geminiStatus: string | null; resolved: boolean; outcomeYes: boolean | null; resolvedAt: number | null;
  quote: MarketQuote; quoteUpdatedAt: number | null; forecasts: number; revealed: number; reads: number; latestDecision: AgentTelemetry | null;
};
export type PricePoint = { ts: number; bid: number | null; ask: number | null; mid: number | null };
export type MarketDetail = MarketSummary & { prices: PricePoint[]; forecastList: MarketForecast[] };
