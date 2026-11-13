import { realizedVolPerMinute, type GeminiClient, type GeminiContract, type GeminiEvent } from '@delphi/shared';

export type Signal = { spot: number; strike: number; sigmaPerMinute: number; minutes: number; spotSymbol: string; volWindow: number };

/** Lukka settlement index → Gemini spot symbol used as the signal source. Basis between the two is accepted model error. */
const SPOT_BY_INDEX: Record<string, string> = {
  'LS-LRRR-XBTUSD': 'btcusd', 'LS-LRRR-ETHUSD': 'ethusd', 'LS-LRRR-SOLNUSD': 'solusd',
  'LS-LRRR-XRPUSD': 'xrpusd', 'LS-LRRR-HYPE22USD': 'hypeusd', 'LS-LRRR-ZECUSD': 'zecusd',
};
const VOL_WINDOW = 240;
const MIN_CANDLES = 60;

/** Per-poll cache of spot and realized vol so a dozen contracts on one index cost two requests. */
export class SignalCache {
  private readonly feeds = new Map<string, Promise<{ spot: number; sigmaPerMinute: number; volWindow: number }>>();
  constructor(private readonly gemini: GeminiClient, private readonly now: () => number = Date.now) {}
  /** Returns null when the contract has no threshold yet (reference strikes publish five minutes before expiry) or no mapped spot feed. */
  async for(event: GeminiEvent, contract: GeminiContract): Promise<Signal | null> {
    const spotSymbol = SPOT_BY_INDEX[event.sourceDetails?.index ?? ''];
    const type = contract.strike?.type, strike = Number(contract.strike?.value);
    if (!spotSymbol || (type !== 'above' && type !== 'reference') || !Number.isFinite(strike) || strike <= 0) return null;
    const minutes = (Date.parse(contract.expiryDate ?? event.expiryDate ?? '') - this.now()) / 60000;
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    const feed = await this.feed(spotSymbol);
    return { ...feed, strike, minutes, spotSymbol };
  }
  private feed(symbol: string): Promise<{ spot: number; sigmaPerMinute: number; volWindow: number }> {
    let pending = this.feeds.get(symbol);
    if (!pending) {
      pending = (async () => {
        const [spot, closes] = await Promise.all([this.gemini.spot(symbol), this.gemini.minuteCloses(symbol)]);
        if (closes.length < MIN_CANDLES) throw new Error(`Insufficient candle history for ${symbol}`);
        const window = closes.slice(-VOL_WINDOW);
        return { spot, sigmaPerMinute: realizedVolPerMinute(window), volWindow: window.length };
      })();
      pending.catch(() => this.feeds.delete(symbol));
      this.feeds.set(symbol, pending);
    }
    return pending;
  }
}
