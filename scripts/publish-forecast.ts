import { parseArgs } from 'node:util';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, getMint } from '@solana/spl-token';
import { loadEnv, REPO_ROOT, connection, loadKeypair, DelphiProgram, GeminiClient, pdas, marketHash, commitment, randomSalt } from '@delphi/shared';
import { openStore, find, persist } from '../services/forecaster/src/store.js';
import { publicationAudience, publicationMessage, type PublicationPayload } from '../services/forecaster/src/publishing-protocol.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    keypair: { type: 'string' }, name: { type: 'string' }, 'price-micro-usdc': { type: 'string', default: '10000' },
    event: { type: 'string' }, symbol: { type: 'string' }, 'prob-bps': { type: 'string' },
    'rationale-file': { type: 'string' }, url: { type: 'string' }, store: { type: 'string', default: 'data/publisher.sqlite' },
    help: { type: 'boolean' },
  }, strict: true });
  if (values.help) {
    console.log('Usage: npx tsx scripts/publish-forecast.ts --keypair keys/my-wallet.json --name my-name --event GEMINI_EVENT_TICKER --symbol GEMI-INSTRUMENT --prob-bps 6500 [--price-micro-usdc 10000] [--rationale-file rationale.txt] [--url https://forecaster.example] [--store data/publisher.sqlite]\nRegisters the local wallet, posts an immutable commitment, then signs and uploads the hosted reveal. The keypair stays local. Repeating the command recovers the same durable salt. Devnet or loopback RPC only; wallet needs SOL and the configured USDC mint must exist.');
    return;
  }
  const env = loadEnv();
  if (!values.keypair || !values.name || !values.event || !values.symbol || values['prob-bps'] === undefined) throw new Error('Missing arguments; use --help');
  const probBps = Number(values['prob-bps']);
  if (!/^\d+$/.test(values['prob-bps']) || !Number.isInteger(probBps) || probBps < 0 || probBps > 10000) throw new Error('Probability must be 0..10000 basis points');
  if (!/^[A-Za-z0-9_-]+$/.test(values.event) || values.event.length > 128 || !/^GEMI-[A-Za-z0-9_-]+$/.test(values.symbol) || values.symbol.length > 64 || Buffer.byteLength(values.name) > 32 || !values.name.trim()) throw new Error('Invalid event, instrument or forecaster name');
  const price = BigInt(values['price-micro-usdc']);
  if (price < 1n || price > 1000000n) throw new Error('Price must be 1..1000000 micro-USDC');
  const rationale = values['rationale-file'] ? readFileSync(resolve(values['rationale-file']), 'utf8') : '';
  if (Buffer.byteLength(rationale) > 4096) throw new Error('Rationale exceeds 4096 UTF-8 bytes');
  const audience = publicationAudience(values.url ?? env.FORECASTER_URL);
  const conn = connection(env);
  const genesisHash = await conn.getGenesisHash();
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.SOLANA_RPC_URL).hostname);
  if ((!local && genesisHash !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') || genesisHash.startsWith('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') || genesisHash.startsWith('4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z')) throw new Error('Publishing CLI permits devnet or local validator only');
  const response = await fetch(`${audience}/publishing`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Publishing service unavailable');
  const metadata: unknown = await response.json();
  if (!metadata || typeof metadata !== 'object' || !('audience' in metadata) || metadata.audience !== audience || !('programId' in metadata) || metadata.programId !== env.DELPHI_PROGRAM_ID || !('genesisHash' in metadata) || metadata.genesisHash !== genesisHash || !('version' in metadata) || metadata.version !== 1) throw new Error('Publishing service domain differs from local chain configuration');
  const wallet = loadKeypair(values.keypair);
  const programId = new PublicKey(env.DELPHI_PROGRAM_ID);
  const client = new DelphiProgram(conn, wallet, programId);
  const gemini = new GeminiClient({ publicBase: env.GEMINI_PUBLIC_API_BASE, privateBase: env.GEMINI_API_BASE });
  const event = await gemini.getEvent(values.event);
  const contract = event.contracts.find(c => c.instrumentSymbol === values.symbol);
  const expiry = Date.parse(contract?.expiryDate ?? event.expiryDate ?? '');
  if (event.ticker !== values.event || event.type !== 'binary' || event.status !== 'active' || !contract || contract.status !== 'active' || contract.resolutionSide != null || contract.resolvedAt != null || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Exact Gemini contract is not active and unexpired');
  const account = await client.fetchForecaster(wallet.publicKey);
  if (!account) await client.registerForecaster(values.name, price);
  else if (account.pricePerRead !== price || account.name !== values.name) throw new Error('Existing registry name/price differ; supply the registered values');
  const mint = new PublicKey(env.USDC_MINT);
  if ((await getMint(conn, mint, 'confirmed')).decimals !== 6) throw new Error('USDC mint must use six decimals');
  await getOrCreateAssociatedTokenAccount(conn, wallet, mint, wallet.publicKey, false, 'confirmed');
  const addresses = pdas(programId);
  const forecastPda = addresses.forecast(addresses.forecaster(wallet.publicKey), marketHash(values.symbol));
  process.umask(0o077);
  const path = resolve(REPO_ROOT, values.store);
  const db = openStore(path);
  for (const suffix of ['', '-wal', '-shm']) { try { chmodSync(`${path}${suffix}`, 0o600); } catch { /* SQLite sidecar may not exist yet. */ } }
  chmodSync(dirname(path), 0o700);
  try {
    let row = find(db, forecastPda.toBase58());
    let chain = await client.fetchForecast(forecastPda);
    if (!row && chain) throw new Error('On-chain forecast exists without the local reveal; refusing to replace it');
    if (!row) {
      row = { forecast_pda: forecastPda.toBase58(), persona: `external:${wallet.publicKey.toBase58()}`, event_ticker: values.event, instrument_symbol: values.symbol, prob_bps: probBps, salt_hex: Buffer.from(randomSalt()).toString('hex'), rationale, posted_at: Math.floor(Date.now() / 1000), tx: null };
      // Durable secret storage precedes any broadcast that depends on it.
      persist(db, row);
    } else if (row.prob_bps !== probBps || row.rationale !== rationale || row.event_ticker !== values.event || row.instrument_symbol !== values.symbol || row.persona !== `external:${wallet.publicKey.toBase58()}`) throw new Error('Local immutable forecast differs from arguments; original reveal preserved');
    const digest = commitment(row.prob_bps, Buffer.from(row.salt_hex, 'hex'));
    if (!chain) {
      await client.initMarket(values.symbol);
      const market = await client.fetchMarket(values.symbol);
      if (!market || market.resolved || expiry <= Date.now()) throw new Error('Market no longer available');
      const tx = await client.postForecast(values.symbol, digest);
      db.prepare('UPDATE reveals SET tx=? WHERE forecast_pda=?').run(tx, row.forecast_pda);
      chain = await client.fetchForecast(forecastPda);
    }
    if (!chain || chain.revealed || chain.forfeited || !Buffer.from(chain.commitment).equals(Buffer.from(digest))) throw new Error('Committed forecast no longer matches an available reveal');
    const now = Math.floor(Date.now() / 1000);
    const payload: PublicationPayload = { version: 1, audience, programId: programId.toBase58(), genesisHash, authority: wallet.publicKey.toBase58(), forecastPda: forecastPda.toBase58(), eventTicker: values.event, instrumentSymbol: values.symbol, probBps: row.prob_bps, salt: row.salt_hex, rationale: row.rationale, nonce: randomBytes(32).toString('hex'), issuedAt: now, expiresAt: now + 300 };
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(wallet.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
    const signature = sign(null, publicationMessage(payload), privateKey).toString('base64');
    const published = await fetch(`${audience}/publications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload, signature }), redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!published.ok) {
      await published.body?.cancel();
      throw new Error(`Publication returned HTTP ${published.status}; reveal preserved locally. HTTP 409 may mean this immutable forecast is already hosted; inspect the free listing.`);
    }
    await published.body?.cancel();
    console.log(`Published ${forecastPda.toBase58()} at ${audience}/forecasts/published/${forecastPda.toBase58()}`);
  } finally { db.close(); }
}
main().catch((error: unknown) => {
  // Never print RPC or HTTP response bodies: they may echo the uploaded reveal.
  console.error(error instanceof Error && /^(Missing arguments|Probability must|Invalid event|Price must|Rationale exceeds|Publishing CLI|Publishing service|Exact Gemini|Existing registry|USDC mint|On-chain forecast|Local immutable|Market no longer|Committed forecast|Publication returned)/.test(error.message) ? error.message : 'Publishing failed; verify arguments, RPC, local keypair, wallet SOL and service availability. Local reveal is preserved after persistence.');
  process.exitCode = 1;
});
