import express from 'express';
import { resolve } from 'node:path';
import { chmodSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { loadEnv, REPO_ROOT, log, connection, loadKeypair, DelphiProgram, GeminiClient, pdas, marketHash, commitment, randomSalt, midPrice } from '@delphi/shared';
import type { ForecastListing, GeminiContract, GeminiEvent } from '@delphi/shared';
import { openStore, find, persist } from './store.js';
import { forecast, slugs } from './strategy.js';
import { SignalCache } from './signal.js';

const env = loadEnv();
const conn = connection(env);
const programId = new PublicKey(env.DELPHI_PROGRAM_ID);
const pda = pdas(programId);
const dbPath = resolve(REPO_ROOT, process.env.FORECASTER_DB || 'data/forecaster.sqlite');
const db = openStore(dbPath);
chmodSync(dbPath, 0o600);
const gemini = new GeminiClient({ publicBase: env.GEMINI_PUBLIC_API_BASE, privateBase: env.GEMINI_API_BASE });
const price = BigInt(process.env.FORECASTER_PRICE_MICRO_USDC || '10000');
if (price <= 0n || price > 1000000n) throw new Error('FORECASTER_PRICE_MICRO_USDC must be between 1 and 1000000');
const count = Number(process.env.FORECASTER_MARKET_LIMIT || 12);
if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Invalid FORECASTER_MARKET_LIMIT');
const personas = await Promise.all(slugs.map(async slug => {
  const key = loadKeypair(`keys/persona-${slug}.json`);
  const client = new DelphiProgram(conn, key, programId);
  const account = await client.fetchForecaster(key.publicKey);
  if (!account) throw new Error(`Persona ${slug} not registered; run setup after deployment`);
  if (account.pricePerRead !== price) throw new Error(`Persona ${slug} on-chain price does not match configured price`);
  await getAccount(conn, getAssociatedTokenAddressSync(new PublicKey(env.USDC_MINT), key.publicKey), 'confirmed');
  return { slug, key, client };
}));
let live = new Map<string, ForecastListing>();
let lastPoll = 0;
let stopping = false;
let running: Promise<void> | undefined;
const app = express();
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.status(lastPoll && Date.now() - lastPoll < 180000 ? 200 : 503).json({ ok: Boolean(lastPoll && Date.now() - lastPoll < 180000), active: live.size, lastPoll }));
app.get('/forecasts', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!lastPoll || Date.now() - lastPoll > 120000) { res.status(503).json({ error: 'Market refresh unavailable' }); return; }
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
  res.json([...live.values()].filter(r => !symbol || r.instrumentSymbol === symbol));
});
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL }));
resourceServer.register(env.SOLANA_NETWORK_CAIP2 as `${string}:${string}`, new ExactSvmScheme({ rpcUrl: env.SOLANA_RPC_URL }));
for (const persona of personas) {
  const route = `/forecasts/${persona.slug}/:pda`;
  app.get(route, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const row = find(db, req.params.pda!);
      if (!row || row.persona !== persona.slug || !live.has(row.forecast_pda) || Date.now() - lastPoll > 120000) { res.status(404).json({ error: 'Forecast unavailable' }); return; }
      const market = await persona.client.fetchMarket(row.instrument_symbol);
      const chain = await persona.client.fetchForecast(new PublicKey(row.forecast_pda));
      if (!market || market.resolved || !chain || chain.revealed || !Buffer.from(chain.commitment).equals(Buffer.from(commitment(row.prob_bps, Buffer.from(row.salt_hex, 'hex'))))) { res.status(409).json({ error: 'Forecast no longer available' }); return; }
      res.locals.reveal = row;
      next();
    } catch { res.status(503).json({ error: 'Forecast verification unavailable' }); }
  });
  app.use(paymentMiddleware({ [`GET ${route}`]: { accepts: [{ scheme: 'exact', network: env.SOLANA_NETWORK_CAIP2 as `${string}:${string}`, payTo: persona.key.publicKey.toBase58(), price: { amount: price.toString(), asset: env.USDC_MINT, extra: { decimals: 6 } } }], description: `Experimental ${persona.slug} probability forecast`, mimeType: 'application/json' } }, resourceServer));
  app.get(route, (_req, res) => {
    const row = res.locals.reveal as import('./store.js').Reveal;
    // The SDK attaches PAYMENT-RESPONSE after settlement. Do not manufacture a receipt.
    res.json({ forecastPda: row.forecast_pda, instrumentSymbol: row.instrument_symbol, probBps: row.prob_bps, salt: row.salt_hex, rationale: row.rationale, forecasterName: persona.slug });
  });
}
app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log('error', 'Forecaster HTTP request failed');
  if (!res.headersSent) res.status(503).json({ error: 'Service unavailable' });
});

async function candidates(): Promise<{ event: GeminiEvent; contract: GeminiContract; mid: number }[]> {
  const selected: { event: GeminiEvent; contract: GeminiContract; mid: number }[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await gemini.listEvents({ status: ['active'], limit: 100, offset });
    for (const event of page.data) {
      if (event.type !== 'binary' || event.status.toLowerCase() !== 'active') continue;
      for (const contract of event.contracts) {
        const expiry = Date.parse(contract.expiryDate || event.expiryDate || '');
        const mid = midPrice(contract);
        if (contract.status.toLowerCase() !== 'active' || contract.resolutionSide !== null || !Number.isFinite(expiry) || expiry < Date.now() + 120000 || expiry > Date.now() + 86400000 || mid === null || mid <= 0 || mid >= 1) continue;
        selected.push({ event, contract, mid });
      }
    }
    if (!page.data.length || offset + page.data.length >= page.pagination.total) break;
    if (offset >= 9900) throw new Error('Market pagination exceeded safety limit');
  }
  return selected.sort((a, b) => Date.parse(a.contract.expiryDate || a.event.expiryDate!) - Date.parse(b.contract.expiryDate || b.event.expiryDate!)).slice(0, count);
}
async function poll(): Promise<void> {
  const next = new Map<string, ForecastListing>();
  const signals = new SignalCache(gemini);
  let abstained = 0;
  for (const { event, contract, mid } of await candidates()) {
    if (stopping) return;
    const symbol = contract.instrumentSymbol;
    const now = Date.now();
    const old = db.prepare('SELECT mid FROM observations WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 1').get(symbol, now - 900000, now - 60000) as { mid: number } | undefined;
    db.prepare('INSERT OR REPLACE INTO observations VALUES(?,?,?)').run(symbol, now, mid);
    for (const persona of personas) {
      try {
        const forecasterPda = pda.forecaster(persona.key.publicKey);
        const forecastPda = pda.forecast(forecasterPda, marketHash(symbol));
        const address = forecastPda.toBase58();
        let row = find(db, address);
        let chain = await persona.client.fetchForecast(forecastPda);
        if (!row && chain) { log('error', 'Existing forecast has no local reveal; refusing overwrite', { persona: persona.slug, forecastPda: address }); continue; }
        if (!row) {
          let signal = null;
          if (persona.slug === 'quant') { try { signal = await signals.for(event, contract); } catch { log('warn', 'Spot signal unavailable; quant abstains this poll', { instrumentSymbol: symbol }); } }
          const prediction = forecast(persona.slug, mid, old?.mid ?? null, signal);
          if (!prediction) { abstained++; continue; }
          row = { forecast_pda: address, persona: persona.slug, event_ticker: event.ticker, instrument_symbol: symbol, prob_bps: prediction.probBps, salt_hex: Buffer.from(randomSalt()).toString('hex'), rationale: prediction.rationale, posted_at: Math.floor(now / 1000), tx: null };
          // FULL synchronous SQLite commit precedes any transaction broadcast.
          persist(db, row);
        }
        const digest = commitment(row.prob_bps, Buffer.from(row.salt_hex, 'hex'));
        if (!chain) {
          await persona.client.initMarket(symbol);
          const market = await persona.client.fetchMarket(symbol);
          if (!market || market.resolved) continue;
          const tx = await persona.client.postForecast(symbol, digest);
          db.prepare('UPDATE reveals SET tx=? WHERE forecast_pda=?').run(tx, address);
          chain = await persona.client.fetchForecast(forecastPda);
        }
        // A crash after broadcast is reconciled against the immutable chain commitment.
        if (!chain || !Buffer.from(chain.commitment).equals(Buffer.from(digest)) || !chain.forecaster.equals(forecasterPda) || row.persona !== persona.slug) { log('error', 'Forecast reconciliation failed', { forecastPda: address }); continue; }
        const market = await persona.client.fetchMarket(symbol);
        const account = await persona.client.fetchForecaster(persona.key.publicKey);
        if (!market || market.resolved || chain.revealed || !account || chain.pricePerRead !== price) continue;
        db.prepare('UPDATE reveals SET posted_at=? WHERE forecast_pda=?').run(chain.postedAt, address);
        next.set(address, { forecastPda: address, forecasterPda: forecasterPda.toBase58(), forecasterAuthority: persona.key.publicKey.toBase58(), forecasterName: persona.slug, instrumentSymbol: symbol, pricePerReadUsdc: Number(price) / 1e6, reputationBps: account.reputationBps, scoredCount: account.scoredCount, postedAt: chain.postedAt, url: `${env.FORECASTER_URL.replace(/\/$/, '')}/forecasts/${persona.slug}/${address}` });
      } catch { log('error', 'Persona forecast reconciliation failed', { persona: persona.slug, instrumentSymbol: symbol }); }
    }
  }
  db.prepare('DELETE FROM observations WHERE ts < ?').run(Date.now() - 86400000);
  live = next;
  lastPoll = Date.now();
  log('info', 'Forecast refresh completed', { active: live.size, abstained });
}
function tick(): void {
  if (running || stopping) return;
  running = poll().catch(() => { log('error', 'Market refresh failed'); }).finally(() => { running = undefined; });
}
const server = app.listen(env.FORECASTER_PORT, process.env.FORECASTER_HOST || '127.0.0.1', () => log('info', 'Forecaster listening', { port: env.FORECASTER_PORT }));
server.requestTimeout = 30000;
const timer = setInterval(tick, 60000);
tick();
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 30000); deadline.unref();
  await Promise.all([new Promise<void>(done => server.close(() => done())), running]);
  db.close();
  clearTimeout(deadline);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
