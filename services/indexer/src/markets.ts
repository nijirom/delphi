import { GeminiClient, eventTickerFromSymbol, midPrice, type GeminiContract, type GeminiEvent, type AgentTelemetry, type MarketSummary, type MarketDetail, type MarketForecast, type MarketQuote } from '@delphi/shared';
import type { ChainIndexer, ForecastSnapshot } from './chain.js';
import type { Store } from './store.js';

type Meta = { eventTicker: string; title: string; category: string; expiryDate: string | null; status: string; resolutionSide: 'yes' | 'no' | null; quote: MarketQuote; fetchedAt: number };
const num = (v: string | null | undefined): number | null => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null; };
function quote(c: GeminiContract): MarketQuote { return { bestBid: num(c.prices.bestBid), bestAsk: num(c.prices.bestAsk), lastTradePrice: num(c.prices.lastTradePrice), mid: midPrice(c) }; }
function meta(event: GeminiEvent, c: GeminiContract): Meta {
  return { eventTicker: event.ticker, title: event.title, category: event.category, expiryDate: c.expiryDate ?? event.expiryDate, status: c.status, resolutionSide: c.resolutionSide ?? null, quote: quote(c), fetchedAt: Date.now() };
}

/** Gemini metadata and sampled quotes for every market the program knows about. */
export class Markets {
  private readonly meta = new Map<string, Meta>();
  private readonly misses = new Map<string, number>();
  constructor(private readonly store: Store, private readonly chain: ChainIndexer, private readonly gemini: GeminiClient) {
    store.db.exec('CREATE TABLE IF NOT EXISTS prices(symbol TEXT NOT NULL, ts INTEGER NOT NULL, bid REAL, ask REAL, mid REAL, PRIMARY KEY(symbol, ts))');
  }
  /** Refresh quotes for known markets: active list for live ones, per-event lookups (rate limited) for the rest. */
  async refresh(): Promise<void> {
    const symbols = new Set(this.chain.symbols.values());
    if (!symbols.size) return;
    const seen = new Set<string>();
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = await this.gemini.listEvents({ status: ['active'], limit: 100, offset });
      for (const event of page.data) for (const c of event.contracts) if (symbols.has(c.instrumentSymbol)) { this.meta.set(c.instrumentSymbol, meta(event, c)); seen.add(c.instrumentSymbol); }
      if (!page.data.length || offset + 100 >= page.pagination.total) break;
    }
    for (const symbol of symbols) {
      if (seen.has(symbol)) continue;
      const cached = this.meta.get(symbol);
      if (cached && (cached.resolutionSide !== null || Date.now() - cached.fetchedAt < 300000)) continue;
      if (Date.now() - (this.misses.get(symbol) ?? 0) < 300000) continue;
      try {
        const event = await this.gemini.getEvent(cached?.eventTicker ?? eventTickerFromSymbol(symbol));
        const c = event.contracts.find(x => x.instrumentSymbol === symbol);
        if (c) this.meta.set(symbol, meta(event, c)); else this.misses.set(symbol, Date.now());
      } catch { this.misses.set(symbol, Date.now()); }
    }
    const insert = this.store.db.prepare('INSERT OR IGNORE INTO prices VALUES(?,?,?,?,?)');
    const ts = Date.now();
    this.store.db.transaction(() => {
      for (const symbol of seen) { const q = this.meta.get(symbol)!.quote; if (q.mid !== null) insert.run(symbol, ts, q.bestBid, q.bestAsk, q.mid); }
      this.store.db.prepare('DELETE FROM prices WHERE ts < ?').run(ts - 7 * 86400000);
    })();
  }
  private decision(symbol: string): AgentTelemetry | null {
    const rows = this.store.telemetry(500) as AgentTelemetry[];
    const index = rows.findIndex(t => t.instrumentSymbol === symbol && ['aggregate', 'decide', 'approve', 'trade', 'skip', 'error'].includes(t.stage));
    if (index < 0) return null;
    const latest = rows[index];
    const observations: AgentTelemetry[] = [];
    // Preserve sizing and the pooled forecast only within this buyer scan.
    // A later skip/error must never be masked by an earlier decision.
    for (let i = index; i < rows.length && rows[i].stage !== 'scan'; i++) {
      if (rows[i].instrumentSymbol === symbol) observations.push(rows[i]);
    }
    const detail: Record<string, unknown> = {};
    for (let i = observations.length - 1; i >= 0; i--) Object.assign(detail, observations[i].detail);
    return { ...latest, detail };
  }
  private forecasts(marketPda: string): MarketForecast[] {
    const names = new Map(this.store.leaderboard().map(r => [r.forecasterPda, r]));
    return this.chain.forecasts.filter(f => f.market === marketPda).map(f => {
      const owner = names.get(f.forecaster);
      return { forecastPda: f.pubkey, forecasterPda: f.forecaster, forecasterName: owner?.name ?? f.forecaster.slice(0, 8), reputationBps: owner?.reputationBps ?? 5000, pricePerReadUsdc: f.pricePerRead / 1e6, reads: f.reads, postedAt: f.postedAt * 1000, revealed: f.revealed, probBps: f.revealed ? f.probBps : null, brierBps: f.revealed ? f.brierBps : null };
    }).sort((a, b) => b.reputationBps - a.reputationBps);
  }
  summary(marketPda: string, symbol: string): MarketSummary {
    const m = this.meta.get(symbol), state = this.chain.markets.get(marketPda), list = this.forecasts(marketPda);
    return {
      instrumentSymbol: symbol, marketPda, eventTicker: m?.eventTicker ?? null, title: m?.title ?? null, category: m?.category ?? null,
      expiryDate: m?.expiryDate ?? null, geminiStatus: m?.status ?? null, resolved: state?.resolved ?? false, outcomeYes: state?.resolved ? state.outcomeYes : null, resolvedAt: state?.resolved ? state.resolvedAt * 1000 : null,
      quote: m?.quote ?? { bestBid: null, bestAsk: null, lastTradePrice: null, mid: null },
      forecasts: list.length, revealed: list.filter(f => f.revealed).length, reads: list.reduce((n, f) => n + f.reads, 0), latestDecision: this.decision(symbol),
    };
  }
  list(): MarketSummary[] {
    return [...this.chain.symbols].map(([pda, symbol]) => this.summary(pda, symbol))
      .sort((a, b) => Number(a.resolved) - Number(b.resolved) || (Date.parse(a.expiryDate ?? '') || Infinity) - (Date.parse(b.expiryDate ?? '') || Infinity));
  }
  detail(symbol: string): MarketDetail | null {
    const entry = [...this.chain.symbols].find(([, s]) => s === symbol);
    if (!entry) return null;
    const prices = (this.store.db.prepare('SELECT ts, bid, ask, mid FROM prices WHERE symbol=? ORDER BY ts').all(symbol) as { ts: number; bid: number | null; ask: number | null; mid: number | null }[]);
    return { ...this.summary(entry[0], symbol), prices, forecastList: this.forecasts(entry[0]) };
  }
  categories(): string[] { return [...new Set([...this.meta.values()].map(m => m.category))].sort(); }
}
