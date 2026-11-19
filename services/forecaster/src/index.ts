import express from 'express';
import { dirname, resolve } from 'node:path';
import { chmodSync } from 'node:fs';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { loadEnv, REPO_ROOT, log, connection, loadKeypair, DelphiProgram, GeminiClient, pdas, marketHash, commitment, randomSalt, midPrice, surviveTransientRpcRejections } from '@delphi/shared';
import type { ForecastListing, GeminiContract, GeminiEvent } from '@delphi/shared';
import { openStore, find, persist, type Reveal } from './store.js';
import { forecast, slugs } from './strategy.js';
import { SignalCache } from './signal.js';
import { selectMarkets, type Candidate } from './selection.js';
import { registerPublishingRoutes } from './publishing.js';
import { createPublishingStore } from './publishing-store.js';
import { registerChannelRoutes } from './channels.js';

const env = loadEnv();
surviveTransientRpcRejections();
const conn = connection(env);
const programId = new PublicKey(env.DELPHI_PROGRAM_ID);
const pda = pdas(programId);
const dbPath = resolve(REPO_ROOT, process.env.FORECASTER_DB || 'data/forecaster.sqlite');
// Salts are the paid product. The -wal and -shm files hold them too, so restrict the mode SQLite creates them with.
process.umask(0o077);
const db = openStore(dbPath);
for (const suffix of ['', '-wal', '-shm']) { try { chmodSync(`${dbPath}${suffix}`, 0o600); } catch { /* absent until SQLite creates it */ } }
chmodSync(dirname(dbPath), 0o700);
const gemini = new GeminiClient({ publicBase: env.GEMINI_PUBLIC_API_BASE, privateBase: env.GEMINI_API_BASE });
const price = BigInt(process.env.FORECASTER_PRICE_MICRO_USDC || '10000');
if (price <= 0n || price > 1000000n) throw new Error('FORECASTER_PRICE_MICRO_USDC must be between 1 and 1000000');
const count = Number(process.env.FORECASTER_MARKET_LIMIT || 12);
if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Invalid FORECASTER_MARKET_LIMIT');
const bondAmount = BigInt(process.env.FORECAST_BOND_MICRO_USDC || '0');
if (bondAmount < 0n || bondAmount > 1000000000n) throw new Error('FORECAST_BOND_MICRO_USDC must be between 0 and 1000000000');
/** Startup reads retry only transport failures (429/5xx/network); a missing or mispriced persona still fails immediately. */
async function startupRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await read(); }
    catch (e) {
      const transient = e instanceof Error && /429|50[234]|fetch failed|ECONNRESET|ETIMEDOUT/.test(e.message);
      if (!transient || attempt >= 6) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}
// Sequential: three parallel bursts at boot are exactly what a shared RPC throttles.
const personas: { slug: typeof slugs[number]; key: Keypair; client: DelphiProgram }[] = [];
for (const slug of slugs) {
  const key = loadKeypair(`keys/persona-${slug}.json`);
  const client = new DelphiProgram(conn, key, programId);
  const account = await startupRead(() => client.fetchForecaster(key.publicKey));
  if (!account) throw new Error(`Persona ${slug} not registered; run setup after deployment`);
  if (account.pricePerRead !== price) throw new Error(`Persona ${slug} on-chain price does not match configured price`);
  await startupRead(() => getAccount(conn, getAssociatedTokenAddressSync(new PublicKey(env.USDC_MINT), key.publicKey), 'confirmed'));
  personas.push({ slug, key, client });
}
let live = new Map<string, ForecastListing>();
let lastPoll = 0;
const verifiedCache = new Map<string, { at: number; ok: boolean }>();
let stopping = false;
let running: Promise<void> | undefined;
const app = express();
app.disable('x-powered-by');
/** Listings are a discovery hint; every buyer re-verifies them on-chain before paying. Older than this, the refresh loop is considered down. */
const LISTINGS_MAX_AGE_MS = 600000;
app.get('/health', (_req, res) => { const ok = lastPoll > 0 && Date.now() - lastPoll < 180000; res.status(ok ? 200 : 503).json({ ok, active: live.size, lastPoll }); });
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL }));
resourceServer.register(env.SOLANA_NETWORK_CAIP2 as `${string}:${string}`, new ExactSvmScheme({ rpcUrl: env.SOLANA_RPC_URL }));
const publishing = registerPublishingRoutes(app, {
  client: personas[0]!.client, connection: conn, gemini, store: createPublishingStore(db), resourceServer,
  config: { publicUrl: env.FORECASTER_URL, programId, network: env.SOLANA_NETWORK_CAIP2 as `${string}:${string}`, usdcMint: env.USDC_MINT },
});
app.get('/forecasts', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!lastPoll || Date.now() - lastPoll > LISTINGS_MAX_AGE_MS) { res.status(503).json({ error: 'Market refresh unavailable' }); return; }
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
  res.setHeader('X-Listings-Refreshed-At', String(lastPoll));
  // Third-party publications come from background-verified verdicts; this route never waits on RPC.
  res.json([...[...live.values()].filter(r => !symbol || r.instrumentSymbol === symbol), ...publishing.listings(symbol)]);
});
/** The single source of truth for "may this reveal be sold now": the chain still holds this exact unrevealed, unforfeited commitment on an unresolved market. */
async function sellable(row: Reveal, client: DelphiProgram): Promise<boolean> {
  const cached = verifiedCache.get(row.forecast_pda);
  if (cached && Date.now() - cached.at < 5000) return cached.ok;
  const market = await client.fetchMarket(row.instrument_symbol);
  const chain = await client.fetchForecast(new PublicKey(row.forecast_pda));
  const ok = Boolean(market && !market.resolved && chain && !chain.revealed && !chain.forfeited && Buffer.from(chain.commitment).equals(Buffer.from(commitment(row.prob_bps, Buffer.from(row.salt_hex, 'hex')))));
  verifiedCache.set(row.forecast_pda, { at: Date.now(), ok });
  return ok;
}
const paid = (row: Reveal, persona: string) => ({ forecastPda: row.forecast_pda, instrumentSymbol: row.instrument_symbol, probBps: row.prob_bps, salt: row.salt_hex, rationale: row.rationale, forecasterName: persona });
if (process.env.FORECASTER_CHANNEL_AUTHORIZER_KEYPAIR) {
  // Usage-based bundles: one escrow and one claim for up to sixteen reads from one persona, billed only for what was delivered.
  await registerChannelRoutes(app, {
    db, network: env.SOLANA_NETWORK_CAIP2 as `${string}:${string}`, mint: env.USDC_MINT, rpcUrl: env.SOLANA_RPC_URL, facilitatorUrl: env.X402_FACILITATOR_URL,
    authorizer: loadKeypair(process.env.FORECASTER_CHANNEL_AUTHORIZER_KEYPAIR),
    listings: () => [...live.values()],
    deliver: async pda => {
      const row = find(db, pda), persona = personas.find(p => p.slug === row?.persona);
      return row && persona && live.has(pda) && await sellable(row, persona.client) ? paid(row, persona.slug) : undefined;
    },
  });
}
for (const persona of personas) {
  const route = `/forecasts/${persona.slug}/:pda`;
  app.get(route, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const row = find(db, req.params.pda!);
      if (!row || row.persona !== persona.slug || !live.has(row.forecast_pda) || Date.now() - lastPoll > LISTINGS_MAX_AGE_MS) { res.status(404).json({ error: 'Forecast unavailable' }); return; }
      if (!await sellable(row, persona.client)) { res.status(409).json({ error: 'Forecast no longer available' }); return; }
      res.locals.reveal = row;
      next();
    } catch { res.status(503).json({ error: 'Forecast verification unavailable' }); }
  });
  app.use(paymentMiddleware({ [`GET ${route}`]: { accepts: [{ scheme: 'exact', network: env.SOLANA_NETWORK_CAIP2 as `${string}:${string}`, payTo: persona.key.publicKey.toBase58(), price: { amount: price.toString(), asset: env.USDC_MINT, extra: { decimals: 6 } } }], description: `Experimental ${persona.slug} probability forecast`, mimeType: 'application/json' } }, resourceServer));
  app.get(route, (_req, res) => {
    const row = res.locals.reveal as Reveal;
    // The SDK attaches PAYMENT-RESPONSE after settlement. Do not manufacture a receipt.
    res.json(paid(row, persona.slug));
  });
}
app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log('error', 'Forecaster HTTP request failed');
  if (!res.headersSent) res.status(503).json({ error: 'Service unavailable' });
});

async function candidates(): Promise<Candidate[]> {
  const events: GeminiEvent[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await gemini.listEvents({ status: ['active'], limit: 100, offset });
    events.push(...page.data);
    if (!page.data.length || offset + page.data.length >= page.pagination.total) break;
    if (offset >= 9900) throw new Error('Market pagination exceeded safety limit');
  }
  return selectMarkets(events, Date.now(), count);
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
          const tx = await persona.client.postForecast(symbol, digest, { bondAmount });
          db.prepare('UPDATE reveals SET tx=? WHERE forecast_pda=?').run(tx, address);
          chain = await persona.client.fetchForecast(forecastPda);
        }
        // A crash after broadcast is reconciled against the immutable chain commitment.
        if (!chain || !Buffer.from(chain.commitment).equals(Buffer.from(digest)) || !chain.forecaster.equals(forecasterPda) || row.persona !== persona.slug) { log('error', 'Forecast reconciliation failed', { forecastPda: address }); continue; }
        const market = await persona.client.fetchMarket(symbol);
        const account = await persona.client.fetchForecaster(persona.key.publicKey);
        if (!market || market.resolved || chain.revealed || chain.forfeited || !account || chain.pricePerRead !== price) continue;
        db.prepare('UPDATE reveals SET posted_at=? WHERE forecast_pda=?').run(chain.postedAt, address);
        next.set(address, { forecastPda: address, forecasterPda: forecasterPda.toBase58(), forecasterAuthority: persona.key.publicKey.toBase58(), forecasterName: persona.slug, instrumentSymbol: symbol, pricePerReadUsdc: Number(price) / 1e6, reputationBps: account.reputationBps, scoredCount: account.scoredCount, postedAt: chain.postedAt, url: `${env.FORECASTER_URL.replace(/\/$/, '')}/forecasts/${persona.slug}/${address}` });
      } catch (e) { log('error', 'Persona forecast reconciliation failed', { persona: persona.slug, instrumentSymbol: symbol, reason: e instanceof Error ? e.message : 'unknown' }); }
    }
  }
  db.prepare('DELETE FROM observations WHERE ts < ?').run(Date.now() - 86400000);
  live = next;
  verifiedCache.clear();
  lastPoll = Date.now();
  try { await publishing.refresh(); } catch { log('warn', 'Hosted publication refresh failed'); }
  log('info', 'Forecast refresh completed', { active: live.size, abstained });
}
function tick(): void {
  if (running || stopping) return;
  running = poll().catch((e: unknown) => { log('error', 'Market refresh failed', { reason: e instanceof Error ? e.message : 'unknown' }); }).finally(() => { running = undefined; });
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
