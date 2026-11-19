import express from 'express';
import { PublicKey, type Connection } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { paymentMiddleware, type x402ResourceServer } from '@x402/express';
import type { HTTPRequestContext } from '@x402/core/server';
import { commitment, marketHash, pdas, type DelphiProgram, type ForecastListing, type GeminiClient, type PaidForecast } from '@delphi/shared';
import { authenticatePublication, publicationAudience, PUBLICATION_MAX_BYTES, PUBLICATION_PATH, PUBLICATION_TTL_SECONDS, PublicationError } from './publishing-protocol.js';
import type { HostedPublication, PublishingStore } from './publishing-store.js';

export type PublishingOptions = {
  client: Pick<DelphiProgram, 'fetchForecaster' | 'fetchForecast' | 'fetchMarket'>;
  connection: Connection;
  gemini: Pick<GeminiClient, 'getEvent'>;
  store: PublishingStore;
  config: { publicUrl: string; programId: PublicKey; network: `${string}:${string}`; usdcMint: string };
  resourceServer: x402ResourceServer;
  /** Production defaults to validating the publisher's USDC associated token account through the RPC connection. */
  verifyRecipient?: (authority: PublicKey) => Promise<void>;
};
type Available = { listing: ForecastListing; price: bigint; reveal: PaidForecast };
const paidRoute = '/forecasts/published/:pda';

export function registerPublishingRoutes(app: express.Express, options: PublishingOptions): {
  /** Cached verdicts only; never touches RPC or Gemini, so the free listing stays fast under throttling. */
  listings(symbol?: string): ForecastListing[];
  /** Re-verifies every hosted publication. Call from the background refresh loop. */
  refresh(): Promise<void>;
} {
  const { client, connection, gemini, store, config } = options;
  const audience = publicationAudience(config.publicUrl);
  const addresses = pdas(config.programId);
  let genesisHash: string | undefined;
  const domain = async () => ({ audience, programId: config.programId.toBase58(), genesisHash: genesisHash ??= await connection.getGenesisHash() });
  const verifyRecipient = options.verifyRecipient ?? (async (authority: PublicKey) => {
    const mint = new PublicKey(config.usdcMint);
    const ata = await getAccount(connection, getAssociatedTokenAddressSync(mint, authority), 'confirmed');
    if (!ata.owner.equals(authority) || !ata.mint.equals(mint) || ata.isFrozen) throw new PublicationError(409, 'Publisher USDC recipient unavailable');
  });

  async function available(row: HostedPublication): Promise<Available> {
    const r = row.reveal;
    const authority = new PublicKey(row.authority);
    const forecasterPda = addresses.forecaster(authority);
    const hash = marketHash(r.instrument_symbol);
    const expected = addresses.forecast(forecasterPda, hash);
    if (r.forecast_pda !== expected.toBase58()) throw new PublicationError(409, 'Forecast authority mismatch');
    const [account, forecast, market, event] = await Promise.all([
      client.fetchForecaster(authority), client.fetchForecast(expected), client.fetchMarket(r.instrument_symbol), gemini.getEvent(r.event_ticker),
    ]);
    if (!account || !account.authority.equals(authority) || !forecast || !forecast.forecaster.equals(forecasterPda) || !forecast.market.equals(addresses.market(hash)) || !market || market.instrumentSymbol !== r.instrument_symbol || !Buffer.from(market.marketHash).equals(Buffer.from(hash))) throw new PublicationError(409, 'On-chain forecast ownership mismatch');
    if (market.resolved || forecast.revealed || forecast.forfeited) throw new PublicationError(409, 'Forecast no longer available');
    if (!Buffer.from(forecast.commitment).equals(Buffer.from(commitment(r.prob_bps, Buffer.from(r.salt_hex, 'hex'))))) throw new PublicationError(409, 'Reveal does not match immutable commitment');
    const contract = event.contracts.find(c => c.instrumentSymbol === r.instrument_symbol);
    const expiry = Date.parse(contract?.expiryDate ?? event.expiryDate ?? '');
    if (event.ticker !== r.event_ticker || event.type !== 'binary' || event.status.toLowerCase() !== 'active' || !contract || contract.status.toLowerCase() !== 'active' || contract.resolutionSide != null || contract.resolvedAt != null || !Number.isFinite(expiry) || expiry <= Date.now()) throw new PublicationError(409, 'Gemini contract is not active and unexpired');
    // The immutable forecast price, not the mutable registry price or a caller claim, is what the buyer owes.
    if (forecast.pricePerRead <= 0n || forecast.pricePerRead > 1000000n) throw new PublicationError(409, 'Hosted price must be between 1 and 1000000 micro-USDC');
    await verifyRecipient(authority);
    return {
      listing: { forecastPda: r.forecast_pda, forecasterPda: forecasterPda.toBase58(), forecasterAuthority: row.authority, forecasterName: account.name, instrumentSymbol: r.instrument_symbol, pricePerReadUsdc: Number(forecast.pricePerRead) / 1e6, reputationBps: account.reputationBps, scoredCount: account.scoredCount, postedAt: forecast.postedAt, url: `${audience}/forecasts/published/${r.forecast_pda}` },
      price: forecast.pricePerRead,
      reveal: { forecastPda: r.forecast_pda, instrumentSymbol: r.instrument_symbol, probBps: r.prob_bps, salt: r.salt_hex, rationale: r.rationale, forecasterName: account.name },
    };
  }
  function failure(res: express.Response, error: unknown): void {
    res.status(error instanceof PublicationError ? error.status : 503).json({ error: error instanceof PublicationError ? error.message : 'Publication verification unavailable' });
  }
  app.get('/publishing', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json({ ...await domain(), version: 1, method: 'POST', path: PUBLICATION_PATH, maxBodyBytes: PUBLICATION_MAX_BYTES, maxSignatureLifetimeSeconds: PUBLICATION_TTL_SECONDS, signatureEncoding: 'base64', signatureAlgorithm: 'Ed25519', signingPrefix: `Delphi forecast publication v1\nPOST ${PUBLICATION_PATH}\n`, payloadFields: ['version', 'audience', 'programId', 'genesisHash', 'authority', 'forecastPda', 'eventTicker', 'instrumentSymbol', 'probBps', 'salt', 'rationale', 'nonce', 'issuedAt', 'expiresAt'], encoding: 'UTF-8 prefix followed by JSON object in payloadFields order, no whitespace; salt and 32-byte random nonce are lowercase hex; times are Unix seconds', maxPriceMicroUsdc: '1000000', hostedReveals: true });
    } catch (error) { failure(res, error); }
  });
  app.post(PUBLICATION_PATH, express.json({ limit: PUBLICATION_MAX_BYTES, strict: true, inflate: false }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const payload = authenticatePublication(req.body, await domain());
      if (store.hasNonce(payload.authority, payload.nonce)) throw new PublicationError(409, 'Publication nonce already used');
      const row: HostedPublication = { authority: payload.authority, reveal: { forecast_pda: payload.forecastPda, persona: `external:${payload.authority}`, event_ticker: payload.eventTicker, instrument_symbol: payload.instrumentSymbol, prob_bps: payload.probBps, salt_hex: payload.salt, rationale: payload.rationale, posted_at: payload.issuedAt, tx: null } };
      const checked = await available(row);
      // Slow upstream calls cannot turn an expired signature into a fresh publication.
      authenticatePublication(req.body, await domain());
      row.reveal.posted_at = checked.listing.postedAt;
      store.publish(row, payload.nonce, payload.expiresAt, Math.floor(Date.now() / 1000));
      // Just verified: list it now rather than after the next background refresh.
      verdicts.set(payload.forecastPda, { at: Date.now(), listing: checked.listing });
      res.status(201).json(checked.listing);
    } catch (error) { failure(res, error); }
  });
  // Reject malformed/oversized JSON without reflecting any uploaded salt, signature or parser body.
  app.use(PUBLICATION_PATH, (error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!error) { next(); return; }
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
    res.status(status === 413 ? 413 : 400).json({ error: status === 413 ? 'Publication body too large' : 'Invalid publication body' });
  });

  const prepared = Symbol('verified hosted publication');
  function paidContext(context: HTTPRequestContext): Available {
    const body = context.adapter.getBody?.() as { [prepared]?: Available } | undefined;
    const value = body?.[prepared];
    if (!value) throw new Error('Missing verified publication');
    return value;
  }
  app.get(paidRoute, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const row = store.find(req.params.pda!);
      if (!row) throw new PublicationError(404, 'Forecast unavailable');
      const checked = await available(row);
      req.body = { [prepared]: checked };
      next();
    } catch (error) { failure(res, error); }
  });
  app.use(paymentMiddleware({ [`GET ${paidRoute}`]: {
    accepts: [{ scheme: 'exact', network: config.network, payTo: context => paidContext(context).listing.forecasterAuthority, price: context => ({ amount: paidContext(context).price.toString(), asset: config.usdcMint, extra: { decimals: 6 } }) }],
    description: 'Wallet-authenticated hosted forecast reveal', mimeType: 'application/json',
  } }, options.resourceServer));
  app.get(paidRoute, async (req, res) => {
    try {
      const row = store.find(req.params.pda!);
      if (!row) throw new PublicationError(404, 'Forecast unavailable');
      // x402 settles only successful responses; recheck state after payment verification, before releasing the paid secret.
      res.json((await available(row)).reveal);
    } catch (error) { failure(res, error); }
  });
  // Free listings are discovery hints: buyers and the paid route re-verify on chain before any payment.
  // Verdicts are refreshed in the background; a transient RPC/Gemini failure keeps the last good verdict for up to
  // 5 min instead of hiding every publication. A definitive rejection (PublicationError) removes the row at once.
  const verdicts = new Map<string, { at: number; listing: ForecastListing }>();
  return {
    listings(symbol) {
      const now = Date.now();
      return store.list(symbol).flatMap(row => {
        const cached = verdicts.get(row.reveal.forecast_pda);
        return cached && now - cached.at < 300000 ? [cached.listing] : [];
      });
    },
    async refresh() {
      for (const row of store.list()) {
        const pda = row.reveal.forecast_pda;
        try { verdicts.set(pda, { at: Date.now(), listing: (await available(row)).listing }); }
        catch (error) { if (error instanceof PublicationError) verdicts.delete(pda); }
      }
    },
  };
}
