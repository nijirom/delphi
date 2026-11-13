import { createHmac } from 'node:crypto';
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
export class GeminiClient {
  constructor(private readonly opts: { publicBase: string; privateBase: string; apiKey?: string; apiSecret?: string }) {
    for (const base of [opts.publicBase, opts.privateBase]) {
      const u = new URL(base);
      if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) throw new Error('Invalid Gemini base URL');
    }
  }
  private async request<T>(path: string, method: 'GET' | 'POST' = 'GET', body: Record<string, unknown> = {}, authenticated = false): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authenticated) {
      if (!this.opts.apiKey || !this.opts.apiSecret) throw new Error('Gemini private API credentials are required');
      const payload = Buffer.from(JSON.stringify({ ...body, request: path, nonce: Math.floor(Date.now() / 1000) })).toString('base64');
      headers['X-GEMINI-APIKEY'] = this.opts.apiKey; headers['X-GEMINI-PAYLOAD'] = payload;
      headers['X-GEMINI-SIGNATURE'] = createHmac('sha384', this.opts.apiSecret).update(payload).digest('hex');
      headers['Content-Type'] = 'text/plain'; headers['Content-Length'] = '0';
      headers['Cache-Control'] = 'no-cache';
    }
    let response: Response;
    try { response = await fetch(new URL(path, authenticated ? this.opts.privateBase : this.opts.publicBase), { method, headers, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw new Error(`Gemini ${method} ${path.split('?')[0]} transport failed`); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Gemini ${method} ${path.split('?')[0]} returned HTTP ${response.status}`); }
    try { return await response.json() as T; } catch { throw new Error('Gemini returned invalid JSON'); }
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
