import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
export type GeminiContract = {
  id: string; label: string; ticker: string; instrumentSymbol: string; status: string;
  resolutionSide: 'yes' | 'no' | null; resolvedAt: string | null; expiryDate: string | null;
  prices: { buy: { yes: string; no: string }; sell: { yes: string; no: string }; bestBid: string | null; bestAsk: string | null; lastTradePrice: string | null };
  quantityMinimum?: string; quantityIncrement?: string; priceIncrement?: string; priceMinimum?: string;
  strike?: { value?: string; type?: string; availableAt?: string };
  priceHistory?: { timestamp: string | number; price: string | number }[];
  eventTicker?: string;
};
export type GeminiEvent = { id: string; title: string; ticker: string; category: string; type: 'binary' | 'categorical'; status: string; resolvedAt: string | null; expiryDate: string | null; contracts: GeminiContract[]; settlement?: { value?: string }; sourceDetails?: { agency?: string; index?: string } };
export type GeminiOrder = { orderId: number; status: 'open' | 'filled' | 'cancelled'; symbol: string; side: string; outcome: string; quantity: string; filledQuantity: string; price: string; avgExecutionPrice: string | null };
export type ActiveBinaryOptions = { category?: string[]; search?: string; limit?: number; minExpiryMs?: number; maxExpiryMs?: number; now?: number };
type EventsPage = { data: GeminiEvent[]; pagination: { limit: number; offset: number; total: number } };
const prefix = '/v1/prediction-markets';
function probability(value: unknown): number | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !value.trim())) return null;
  const n = Number(value); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}
export function midPrice(c: GeminiContract): number | null {
  const bid = probability(c.prices?.bestBid), ask = probability(c.prices?.bestAsk);
  if (bid !== null && ask !== null && bid <= ask) return (bid + ask) / 2;
  return probability(c.prices?.lastTradePrice);
}
/** Event ticker = instrument symbol without the `GEMI-` prefix and the trailing contract segment (`-UP`, `-HI68`, `-HOU`). */
export function eventTickerFromSymbol(instrumentSymbol: string): string {
  const body = instrumentSymbol.replace(/^GEMI-/, '');
  const cut = body.lastIndexOf('-');
  return cut > 0 ? body.slice(0, cut) : body;
}
const symbolWindows: Record<string, string> = { '05M': '5m', '15M': '15m', '30M': '30m', '1H': '1h', '4H': '4h', '1D': '1d' };
const symbolCategories: Record<string, string> = {
  BTC: 'Crypto', ETH: 'Crypto', SOL: 'Crypto', XRP: 'Crypto', HYPE: 'Crypto', ZEC: 'Crypto', DOGE: 'Crypto', AVAX: 'Crypto', LINK: 'Crypto',
  NBA: 'Sports', NFL: 'Sports', MLB: 'Sports', NHL: 'Sports', UFC: 'Sports', EPL: 'Sports', NCAAM: 'Sports', NCAAF: 'Sports', WNBA: 'Sports', MLS: 'Sports',
  GDP: 'Economics', UNEMP: 'Economics', CPI: 'Economics', FED: 'Economics', FOMC: 'Economics',
};
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export type ParsedInstrumentSymbol = {
  /** `matchup` symbols carry two opposing legs under one event title; `cadence` symbols are repeating time-window contracts. */
  kind: 'cadence' | 'matchup' | 'unknown';
  asset: string | null; windowLabel: string | null; category: string | null;
  expiryDate: string | null; outcomeLabel: string | null; fallbackTitle: string | null;
};
const unparsed: ParsedInstrumentSymbol = { kind: 'unknown', asset: null, windowLabel: null, category: null, expiryDate: null, outcomeLabel: null, fallbackTitle: null };
export function parseInstrumentSymbol(instrumentSymbol: string): ParsedInstrumentSymbol {
  const matchup = parseMatchupSymbol(instrumentSymbol);
  if (matchup) return matchup;
  const match = /^GEMI-([A-Z]{2,6}?)(?:(05M|15M|30M|1H|4H|1D))?(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-([A-Z0-9]+)$/.exec(instrumentSymbol);
  if (!match) return unparsed;
  const [, asset, rawWindow, yy, mm, dd, hh, min, suffix] = match;
  const year = 2000 + Number(yy), month = Number(mm), day = Number(dd), hour = Number(hh), minute = Number(min);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return unparsed;
  const ts = Date.UTC(year, month - 1, day, hour, minute);
  const d = new Date(ts);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return unparsed;
  const windowLabel = rawWindow ? (symbolWindows[rawWindow] ?? null) : null;
  const category = symbolCategories[asset] ?? null;
  const outcomeLabel = suffix === 'UP' ? 'Up' : suffix === 'DOWN' ? 'Down'
    : /^HI(\d+)$/.test(suffix) ? suffix.replace(/^HI(\d+)$/, 'Above $1')
    : /^LO(\d+)$/.test(suffix) ? suffix.replace(/^LO(\d+)$/, 'Below $1')
    : suffix;
  const fallbackTitle = `${asset}${windowLabel ? ` ${windowLabel}` : ''} · ${monthNames[month - 1]} ${day}, ${hh}:${min} UTC`;
  return { kind: 'cadence', asset, windowLabel, category, expiryDate: d.toISOString(), outcomeLabel, fallbackTitle };
}
/** `GEMI-<LEAGUE>-<YYMMDDHHmm>-<HOME>-<AWAY>-M-<SIDE>`: both legs of one game share a title, so the side is what distinguishes them. */
function parseMatchupSymbol(instrumentSymbol: string): ParsedInstrumentSymbol | null {
  const match = /^GEMI-([A-Z]{2,6})-(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-([A-Z]{2,5})-([A-Z]{2,5})-M-([A-Z]{2,5})$/.exec(instrumentSymbol);
  if (!match) return null;
  const [, league, yy, mm, dd, hh, min, home, away, side] = match;
  const year = 2000 + Number(yy), month = Number(mm), day = Number(dd), hour = Number(hh), minute = Number(min);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return {
    kind: 'matchup', asset: league, windowLabel: null, category: symbolCategories[league] ?? 'Sports', expiryDate: d.toISOString(),
    outcomeLabel: side, fallbackTitle: `${home} vs ${away} · ${side} · ${monthNames[month - 1]} ${day}, ${hh}:${min} UTC`,
  };
}
let lastNonce = 0;
/** Millisecond nonces, forced to increase even when two signed requests land in the same millisecond. */
function nextNonce(): number { lastNonce = Math.max(Date.now(), lastNonce + 1); return lastNonce; }
export class GeminiClient {
  /** `account` scopes a master (account-group) key to one sub-account, e.g. `primary`; single-account keys leave it unset. */
  constructor(private readonly opts: { publicBase: string; privateBase: string; apiKey?: string; apiSecret?: string; account?: string }) {
    for (const base of [opts.publicBase, opts.privateBase]) {
      const u = new URL(base);
      if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) throw new Error('Invalid Gemini base URL');
    }
  }
  private async request<T>(path: string, method: 'GET' | 'POST' = 'GET', body: Record<string, unknown> = {}, authenticated = false): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authenticated) {
      if (!this.opts.apiKey || !this.opts.apiSecret) throw new Error('Gemini private API credentials are required');
      // Gemini requires a strictly increasing nonce per API key; two signed calls can share a wall-clock second.
      const payload = Buffer.from(JSON.stringify({ ...body, ...(this.opts.account ? { account: this.opts.account } : {}), request: path, nonce: nextNonce() })).toString('base64');
      headers['X-GEMINI-APIKEY'] = this.opts.apiKey; headers['X-GEMINI-PAYLOAD'] = payload;
      headers['X-GEMINI-SIGNATURE'] = createHmac('sha384', this.opts.apiSecret).update(payload).digest('hex');
      headers['Content-Type'] = 'text/plain'; headers['Content-Length'] = '0';
      headers['Cache-Control'] = 'no-cache';
    }
    // Public GETs are idempotent: a dropped connection, 429, 5xx or truncated/non-JSON body on one page must not abort a whole catalog walk.
    // Signed requests are never retried; a replayed nonce would be rejected and an order must not be sent twice.
    const attempts = method === 'GET' && !authenticated ? 3 : 1;
    const route = `Gemini ${method} ${path.split('?')[0]}`;
    for (let attempt = 1; ; attempt++) {
      let failure: string;
      let response: Response | undefined;
      try { response = await fetch(new URL(path, authenticated ? this.opts.privateBase : this.opts.publicBase), { method, headers, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
      catch { response = undefined; }
      if (!response) failure = `${route} transport failed`;
      else if (!response.ok) {
        await response.body?.cancel();
        failure = `${route} returned HTTP ${response.status}`;
        if (response.status !== 429 && response.status < 500) throw new Error(failure);
      } else {
        try { return await response.json() as T; } catch { failure = 'Gemini returned invalid JSON'; }
      }
      if (attempt >= attempts) throw new Error(failure);
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  async listEvents(q: { status?: string[]; category?: string[]; search?: string; limit?: number; offset?: number } = {}): Promise<EventsPage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(q)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
    }
    const page = await this.request<EventsPage>(`${prefix}/events${params.size ? '?' + params : ''}`);
    if (!Array.isArray(page.data) || !page.pagination || !Number.isFinite(page.pagination.total)) throw new Error('Gemini events response has invalid pagination');
    for (const event of page.data) this.attachParent(event);
    return page;
  }
  private attachParent(event: GeminiEvent): GeminiEvent {
    if (!event || !Array.isArray(event.contracts) || typeof event.ticker !== 'string') throw new Error('Gemini returned an invalid event');
    for (const c of event.contracts) {
      c.eventTicker = event.ticker;
      c.expiryDate ??= event.expiryDate;
      c.resolutionSide ??= null;
      c.resolvedAt ??= null;
    }
    return event;
  }
  async getEvent(eventTicker: string): Promise<GeminiEvent> {
    const result = await this.request<GeminiEvent | { data: GeminiEvent }>(`${prefix}/events/${encodeURIComponent(eventTicker)}`);
    return this.attachParent('data' in result ? result.data : result);
  }
  async recentlySettled(q: { limit?: number } = {}): Promise<{ data: GeminiEvent[] }> {
    const result = await this.request<{ data: GeminiEvent[] }>(`${prefix}/events/recently-settled${q.limit === undefined ? '' : '?limit=' + q.limit}`);
    if (!Array.isArray(result.data)) throw new Error('Gemini settled response is invalid');
    result.data.forEach(event => this.attachParent(event)); return result;
  }
  async listActiveBinary(opts: ActiveBinaryOptions = {}): Promise<GeminiContract[]> {
    const limit = opts.limit ?? 100, now = opts.now ?? Date.now();
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be positive');
    const found = new Map<string, GeminiContract>(); let offset = 0;
    while (found.size < limit) {
      const page = await this.listEvents({ status: ['active'], category: opts.category, search: opts.search, limit: 100, offset });
      for (const event of page.data) {
        if (event.type !== 'binary' || event.status !== 'active') continue;
        for (const c of event.contracts) {
          if (c.status !== 'active' || c.resolutionSide || midPrice(c) === null) continue;
          if (opts.minExpiryMs !== undefined || opts.maxExpiryMs !== undefined) {
            const remaining = Date.parse(c.expiryDate ?? '') - now;
            if (!Number.isFinite(remaining) || remaining < (opts.minExpiryMs ?? 0) || remaining > (opts.maxExpiryMs ?? Infinity)) continue;
          }
          found.set(c.instrumentSymbol, c);
        }
      }
      offset += page.data.length;
      if (!page.data.length || offset >= page.pagination.total) break;
      if (offset >= 100000) throw new Error('Gemini pagination safety bound exceeded');
    }
    return [...found.values()].sort((a, b) => (Date.parse(a.expiryDate ?? '') || Infinity) - (Date.parse(b.expiryDate ?? '') || Infinity)).slice(0, limit);
  }
  termsStatus(): Promise<{ hasAcceptedLatest: boolean }> { return this.request(`${prefix}/terms/status`, 'GET', {}, true); }
  acceptTerms(): Promise<unknown> { return this.request(`${prefix}/terms/accept`, 'POST', {}, true); }
  async placeOrder(o: { symbol: string; side: 'buy' | 'sell'; outcome: 'yes' | 'no'; quantity: string; price: string; orderType?: 'limit'; timeInForce?: 'good-til-cancel' | 'immediate-or-cancel' | 'fill-or-kill'; makerOrCancel?: boolean }): Promise<GeminiOrder> {
    if (!o.symbol || !['buy', 'sell'].includes(o.side) || !['yes', 'no'].includes(o.outcome) || !Number.isFinite(Number(o.quantity)) || Number(o.quantity) <= 0 || probability(o.price) === null || Number(o.price) <= 0 || Number(o.price) >= 1) throw new Error('Invalid Gemini order');
    if (!(await this.termsStatus()).hasAcceptedLatest) throw new Error('Gemini terms require explicit human acceptance');
    return this.request(`${prefix}/order`, 'POST', { orderType: 'limit', timeInForce: 'immediate-or-cancel', ...o }, true);
  }
  async positions(): Promise<unknown[]> {
    const result = await this.request<unknown[] | { data: unknown[] }>(`${prefix}/positions`, 'GET', {}, true);
    const data = Array.isArray(result) ? result : result.data;
    if (!Array.isArray(data)) throw new Error('Gemini positions response is invalid'); return data;
  }
  /** Public spot last price for a Gemini spot symbol such as `btcusd`. */
  async spot(symbol: string): Promise<number> {
    if (!/^[a-z0-9]{4,12}$/.test(symbol)) throw new RangeError('Invalid spot symbol');
    const ticker = await this.request<{ close?: unknown }>(`/v2/ticker/${symbol}`);
    const price = Number(ticker.close);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Gemini spot ticker is invalid');
    return price;
  }
  /** One-minute candle closes, oldest first. Gemini returns newest first as [time, open, high, low, close, volume]. */
  async minuteCloses(symbol: string): Promise<number[]> {
    if (!/^[a-z0-9]{4,12}$/.test(symbol)) throw new RangeError('Invalid spot symbol');
    const rows = await this.request<unknown[]>(`/v2/candles/${symbol}/1m`);
    if (!Array.isArray(rows)) throw new Error('Gemini candles response is invalid');
    const closes: number[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 5) throw new Error('Gemini candle row is invalid');
      const close = Number(row[4]);
      if (!Number.isFinite(close) || close <= 0) throw new Error('Gemini candle close is invalid');
      closes.push(close);
    }
    return closes.reverse();
  }
}
