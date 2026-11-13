import { GeminiClient, eventTickerFromSymbol, midPrice, type GeminiContract, type GeminiEvent, type AgentTelemetry, type MarketSummary, type MarketDetail, type MarketForecast, type MarketQuote } from '@delphi/shared';
import type { ChainIndexer, ForecastSnapshot } from './chain.js';
import type { Store } from './store.js';

type Meta = { eventTicker: string; title: string; category: string; expiryDate: string | null; status: string; resolutionSide: 'yes' | 'no' | null; quote: MarketQuote; fetchedAt: number };
type RequestContext = { forecasts: Map<string, ForecastSnapshot[]>; decisions: Map<string, AgentTelemetry> };
const lookupCooldown = 300000;
const decisionStages: Partial<Record<AgentTelemetry['stage'], true>> = { aggregate: true, decide: true, approve: true, trade: true, skip: true, error: true };
const num = (v: string | null | undefined): number | null => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null; };
function quote(c: GeminiContract): MarketQuote { return { bestBid: num(c.prices.bestBid), bestAsk: num(c.prices.bestAsk), lastTradePrice: num(c.prices.lastTradePrice), mid: midPrice(c) }; }
function meta(event: GeminiEvent, c: GeminiContract, fetchedAt: number): Meta {
  return { eventTicker: event.ticker, title: event.title, category: event.category, expiryDate: c.expiryDate ?? event.expiryDate, status: c.status, resolutionSide: c.resolutionSide ?? null, quote: quote(c), fetchedAt };
}

/** Gemini metadata and sampled quotes for every market the program knows about. */
export class Markets {
  private readonly meta = new Map<string, Meta>();
  private readonly misses = new Map<string, number>();
  private catalogScanAt = 0;
  constructor(private readonly store: Store, private readonly chain: ChainIndexer, private readonly gemini: GeminiClient) {
    store.db.exec('CREATE TABLE IF NOT EXISTS prices(symbol TEXT NOT NULL, ts INTEGER NOT NULL, bid REAL, ask REAL, mid REAL, PRIMARY KEY(symbol, ts))');
  }
  /** Fetch each known event once; keep terminal metadata and cool down unsuccessful lookups. */
  async refresh(): Promise<void> {
    const symbols = new Set(this.chain.symbols.values());
    for (const symbol of this.meta.keys()) if (!symbols.has(symbol)) this.meta.delete(symbol);
    for (const symbol of this.misses.keys()) if (!symbols.has(symbol)) this.misses.delete(symbol);
    const events = new Map<string, string[]>();
    for (const symbol of symbols) {
      const ticker = this.meta.get(symbol)?.eventTicker ?? eventTickerFromSymbol(symbol);
      const group = events.get(ticker);
      if (group) group.push(symbol); else events.set(ticker, [symbol]);
    }
    const samples: { symbol: string; metadata: Meta }[] = [];
    for (const [ticker, group] of events) {
      const now = Date.now();
      const needed = group.some(symbol => {
        const cached = this.meta.get(symbol), missedAt = this.misses.get(symbol);
        if (missedAt !== undefined && now - missedAt < lookupCooldown) return false;
        if (!cached) return true;
        if (cached.resolutionSide !== null || ['settled', 'resolved'].includes(cached.status.toLowerCase())) return false;
        return cached.status.toLowerCase() === 'active' || now - cached.fetchedAt >= lookupCooldown;
      });
      if (!needed) continue;
      try {
        const event = await this.gemini.getEvent(ticker);
        const fetchedAt = Date.now();
        const contracts = new Map(event.contracts.map(c => [c.instrumentSymbol, c]));
        const fetched = group.map(symbol => {
          const contract = contracts.get(symbol);
          return { symbol, metadata: contract ? meta(event, contract, fetchedAt) : null };
        });
        for (const { symbol, metadata } of fetched) {
          if (!metadata) { this.misses.set(symbol, fetchedAt); continue; }
          this.meta.set(symbol, metadata);
          this.misses.delete(symbol);
          if (metadata.status.toLowerCase() === 'active' && metadata.resolutionSide === null && metadata.quote.mid !== null) samples.push({ symbol, metadata });
        }
      } catch {
        for (const symbol of group) this.misses.set(symbol, Date.now());
      }
    }
    // Backstop: symbols still unknown after direct lookups (ticker convention drift) are matched against the active catalog, at most once per cooldown.
    const unknown = [...symbols].filter(s => !this.meta.has(s) && this.misses.has(s));
    if (unknown.length && Date.now() - this.catalogScanAt >= lookupCooldown) {
      this.catalogScanAt = Date.now();
      const wanted = new Set(unknown);
      try {
        for (let offset = 0; offset < 2000 && wanted.size; offset += 100) {
          const page = await this.gemini.listEvents({ status: ['active'], limit: 100, offset });
          const fetchedAt = Date.now();
          for (const event of page.data) for (const c of event.contracts) {
            if (!wanted.delete(c.instrumentSymbol)) continue;
            const metadata = meta(event, c, fetchedAt);
            this.meta.set(c.instrumentSymbol, metadata); this.misses.delete(c.instrumentSymbol);
            if (metadata.status.toLowerCase() === 'active' && metadata.resolutionSide === null && metadata.quote.mid !== null) samples.push({ symbol: c.instrumentSymbol, metadata });
          }
          if (!page.data.length || offset + 100 >= page.pagination.total) break;
        }
      } catch { /* misses already carry cooldown timestamps */ }
    }
    const insert = this.store.db.prepare('INSERT OR IGNORE INTO prices VALUES(?,?,?,?,?)');
    this.store.db.transaction(() => {
      for (const { symbol, metadata } of samples) {
        const q = metadata.quote;
        insert.run(symbol, metadata.fetchedAt, q.bestBid, q.bestAsk, q.mid);
      }
      this.store.db.prepare('DELETE FROM prices WHERE ts < ?').run(Date.now() - 7 * 86400000);
    })();
  }
  private context(): RequestContext {
    const forecasts = new Map<string, ForecastSnapshot[]>();
    for (const forecast of this.chain.forecasts) {
      const group = forecasts.get(forecast.market);
      if (group) group.push(forecast); else forecasts.set(forecast.market, [forecast]);
    }
    const decisions = new Map<string, AgentTelemetry>();
    const observations = new Map<string, Record<string, unknown>>();
    const rows = this.store.telemetry(500) as AgentTelemetry[];
    // Read oldest first so later stages win, while scan boundaries reset pooled details.
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.stage === 'scan') { observations.clear(); continue; }
      if (!row.instrumentSymbol) continue;
      let detail = observations.get(row.instrumentSymbol);
      if (!detail) { detail = {}; observations.set(row.instrumentSymbol, detail); }
      Object.assign(detail, row.detail);
      if (decisionStages[row.stage]) decisions.set(row.instrumentSymbol, { ...row, detail: { ...detail } });
    }
    return { forecasts, decisions };
  }
  private forecasts(list: ForecastSnapshot[]): MarketForecast[] {
    const names = new Map(this.store.leaderboard().map(r => [r.forecasterPda, r]));
    return list.map(f => {
      const owner = names.get(f.forecaster);
      return { forecastPda: f.pubkey, forecasterPda: f.forecaster, forecasterName: owner?.name ?? f.forecaster.slice(0, 8), reputationBps: owner?.reputationBps ?? 5000, pricePerReadUsdc: f.pricePerRead / 1e6, reads: f.reads, postedAt: f.postedAt * 1000, revealed: f.revealed, probBps: f.revealed ? f.probBps : null, brierBps: f.revealed ? f.brierBps : null };
    }).sort((a, b) => b.reputationBps - a.reputationBps);
  }
  private summarize(marketPda: string, symbol: string, context: RequestContext): MarketSummary {
    const m = this.meta.get(symbol), state = this.chain.markets.get(marketPda), list = context.forecasts.get(marketPda) ?? [];
    let revealed = 0, reads = 0;
    for (const forecast of list) { if (forecast.revealed) revealed++; reads += forecast.reads; }
    return {
      instrumentSymbol: symbol, marketPda, eventTicker: m?.eventTicker ?? null, title: m?.title ?? null, category: m?.category ?? null,
      expiryDate: m?.expiryDate ?? null, geminiStatus: m?.status ?? null, resolved: state?.resolved ?? false, outcomeYes: state?.resolved ? state.outcomeYes : null, resolvedAt: state?.resolved ? state.resolvedAt * 1000 : null,
      quote: m?.quote ?? { bestBid: null, bestAsk: null, lastTradePrice: null, mid: null }, quoteUpdatedAt: m?.fetchedAt ?? null,
      forecasts: list.length, revealed, reads, latestDecision: context.decisions.get(symbol) ?? null,
    };
  }
  summary(marketPda: string, symbol: string): MarketSummary { return this.summarize(marketPda, symbol, this.context()); }
  list(): MarketSummary[] {
    const context = this.context();
    return [...this.chain.symbols].map(([pda, symbol]) => this.summarize(pda, symbol, context))
      .sort((a, b) => Number(a.resolved) - Number(b.resolved) || (Date.parse(a.expiryDate ?? '') || Infinity) - (Date.parse(b.expiryDate ?? '') || Infinity));
  }
  detail(symbol: string): MarketDetail | null {
    const entry = [...this.chain.symbols].find(([, s]) => s === symbol);
    if (!entry) return null;
    const context = this.context();
    const prices = (this.store.db.prepare('SELECT ts, bid, ask, mid FROM prices WHERE symbol=? ORDER BY ts').all(symbol) as { ts: number; bid: number | null; ask: number | null; mid: number | null }[]);
    return { ...this.summarize(entry[0], symbol, context), prices, forecastList: this.forecasts(context.forecasts.get(entry[0]) ?? []) };
  }
  categories(): string[] {
    const categories = new Set<string>();
    for (const symbol of this.chain.symbols.values()) { const m = this.meta.get(symbol); if (m) categories.add(m.category); }
    return [...categories].sort();
  }
}
