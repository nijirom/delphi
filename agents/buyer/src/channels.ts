import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { discoverChannelsByRentPayer, isUptoSvmPayload, toFacilitatorSvmSigner, type DiscoveredChannel, type FacilitatorSvmSigner } from '@x402/svm';
import { UptoSvmScheme } from '@x402/svm/upto/client';
import { marketHash, pdas, type DelphiProgram, type ForecastListing } from '@delphi/shared';
import { DEVNET, DEVNET_USDC, Ledger, safeUrl } from './guardrails.js';
import { validateReceipt, verifyListing, type VerifiedListing } from './x402.js';

const MAX_READS = 16;
const MAX_RECOVERIES_PER_PASS = 2;
const RECOVERY_TIMEOUT_MS = 15000;
const CHANNEL_LOOKUP_TIMEOUT_MS = 10000;
export type Bundle = { id: string; url: string; items: VerifiedListing[]; paymentHeader?: string; value?: unknown; header?: string | null };
export type ChannelBuyerOptions = { base: string; rpcUrl: string; wallet: Keypair; program: DelphiProgram; programId: PublicKey; ledger: Ledger; minReputationBps?: number; fetch?: typeof fetch };
/** Commitments may be Buffers (JSON `{type,data}`) or Uint8Arrays (JSON `{"0":…}`); persist a plain 32-byte array so restore is lossless. */
function persisted(bundle: Bundle): unknown {
  return { ...bundle, items: bundle.items.map(x => ({ ...x, commitment: Array.from(x.commitment) })) };
}
export function restoreBundle(payload: string): Bundle {
  const bundle = JSON.parse(payload) as Bundle;
  for (const item of bundle.items) {
    const raw: unknown = item.commitment;
    if (!Array.isArray(raw) || raw.length !== 32 || !raw.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error('Corrupt persisted commitment');
    item.commitment = Uint8Array.from(raw);
  }
  return bundle;
}
export function allowedChannelQuote(r: PaymentRequirements, items: VerifiedListing[], payer: string): boolean {
  const total = items.reduce((n, x) => n + x.amount, 0);
  return items.length >= 2 && items.length <= MAX_READS && new Set(items.map(x => x.recipient)).size === 1 &&
    r.scheme === 'upto' && r.network === DEVNET && r.asset === DEVNET_USDC && r.payTo === items[0]!.recipient &&
    /^[0-9]+$/.test(r.amount) && BigInt(r.amount) === BigInt(total) &&
    Number.isInteger(r.maxTimeoutSeconds) && r.maxTimeoutSeconds > 0 && r.maxTimeoutSeconds <= 120 &&
    typeof r.extra?.feePayer === 'string' && r.extra.feePayer !== payer &&
    typeof r.extra.receiverAuthorizer === 'string' && Number.isInteger(r.extra.withdrawDelay) && Number(r.extra.withdrawDelay) > 0 && Number(r.extra.withdrawDelay) <= 300 &&
    (r.extra.tokenProgram === undefined || r.extra.tokenProgram === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
}
export function validateBundle(bundle: Bundle, value: unknown, header: string | null, payer: string) {
  if (!value || typeof value !== 'object' || !header || header.length > 16384) throw new Error('Missing bundle receipt');
  const body = value as { id?: unknown; amount?: unknown; forecasts?: unknown };
  if (body.id !== bundle.id || !Array.isArray(body.forecasts) || body.forecasts.length > bundle.items.length) throw new Error('Incorrect bundle');
  const seen = new Set<string>();
  const delivered = body.forecasts.map(value => {
    const id = value?.forecastPda;
    const verified = bundle.items.find(x => x.listing.forecastPda === id);
    if (!verified || seen.has(id)) throw new Error('Unrequested or duplicate forecast');
    seen.add(id);
    const receipt = validateReceipt(verified, value, header);
    return { key: id as string, payload: { verified: { ...verified, commitment: Array.from(verified.commitment) }, value, header }, receipt };
  });
  const amount = String(delivered.reduce((n, x) => n + x.receipt.amount, 0));
  const settlement = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  // Zero-use refunds also require a successful real claim; a deposit receipt is not a delivery receipt.
  if (settlement.success !== true || settlement.network !== DEVNET || settlement.payer !== payer || settlement.amount !== amount || body.amount !== amount) throw new Error('Usage settlement mismatch');
  if (!delivered.length) {
    // validateReceipt validates signatures for non-empty bundles; still enforce it for a zero-use refund.
    const { transaction } = settlement;
    if (typeof transaction !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(transaction)) throw new Error('Invalid refund signature');
  }
  return { delivered, missing: bundle.items.filter(x => !seen.has(x.listing.forecastPda)).map(x => x.listing.forecastPda) };
}
type ChannelReader = (feePayer: string) => Promise<readonly DiscoveredChannel[]>;
function channelReader(o: ChannelBuyerOptions): ChannelReader {
  let signer: Promise<FacilitatorSvmSigner> | undefined;
  return async feePayer => {
    signer ??= createKeyPairSignerFromBytes(o.wallet.secretKey).then(x => toFacilitatorSvmSigner(x, { defaultRpcUrl: o.rpcUrl }));
    return discoverChannelsByRentPayer(await signer, DEVNET, feePayer);
  };
}
async function bounded<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const controller = new AbortController();
  const deadline = delay(timeoutMs, undefined, { signal: controller.signal }).then(() => { throw new Error(message); });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    controller.abort();
  }
}
async function verifyMissingSettlement(o: ChannelBuyerOptions, bundle: Bundle, amount: number, readChannels: ChannelReader): Promise<void> {
  if (!bundle.paymentHeader) throw new Error('Channel authorization unavailable; missing-read reservations retained');
  let payment: PaymentPayload;
  try {
    payment = decodePaymentSignatureHeader(bundle.paymentHeader);
  } catch {
    throw new Error('Channel authorization cannot be decoded; missing-read reservations retained');
  }
  const payer = o.wallet.publicKey.toBase58();
  if (payment.x402Version !== 2 || !payment.payload || !isUptoSvmPayload(payment.payload) ||
      !allowedChannelQuote(payment.accepted, bundle.items, payer)) {
    throw new Error('Channel authorization cannot be independently verified; missing-read reservations retained');
  }
  const payload = payment.payload;
  const total = bundle.items.reduce((sum, item) => sum + item.amount, 0);
  if (payload.from !== payer || payload.maxAmount !== String(total) || payload.deposit !== String(total) ||
      payload.authorizedSigner !== payment.accepted.extra?.receiverAuthorizer ||
      !/^[0-9]+$/.test(payload.nonce) ||
      !(typeof payload.openSlot === 'string' ? /^[0-9]+$/.test(payload.openSlot) : Number.isSafeInteger(payload.openSlot) && payload.openSlot >= 0)) {
    throw new Error('Channel authorization does not match the reservation; missing-read reservations retained');
  }
  const feePayer = payment.accepted.extra?.feePayer;
  if (typeof feePayer !== 'string') throw new Error('Channel fee payer unavailable; missing-read reservations retained');
  let channels: readonly DiscoveredChannel[];
  try {
    channels = await bounded(readChannels(feePayer), CHANNEL_LOOKUP_TIMEOUT_MS, 'On-chain channel lookup timed out');
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'RPC unavailable';
    throw new Error(`On-chain channel lookup unavailable (${reason}); missing-read reservations retained`);
  }
  const found = channels.find(x => x.channelId === payload.channelId);
  if (!found) throw new Error('On-chain channel outcome unavailable; missing-read reservations retained');
  const channel = found.channel;
  if (channel.status !== 3 || channel.payer !== payer || channel.payee !== feePayer ||
      channel.authorizedSigner !== payload.authorizedSigner || channel.mint !== DEVNET_USDC ||
      channel.deposit !== BigInt(total) || channel.gracePeriod !== payment.accepted.extra?.withdrawDelay ||
      channel.salt !== BigInt(payload.nonce) || channel.openSlot !== BigInt(payload.openSlot) ||
      channel.settlement.settled !== BigInt(amount) || channel.settlement.payoutWatermark !== BigInt(amount)) {
    throw new Error('On-chain channel outcome does not prove the claimed settlement; missing-read reservations retained');
  }
}
async function finishValidatedBundle(o: ChannelBuyerOptions, bundle: Bundle, value: unknown, header: string | null, readChannels: ChannelReader): Promise<void> {
  const candidate = { ...bundle, value, header };
  const result = validateBundle(candidate, value, header, o.wallet.publicKey.toBase58());
  // A malformed server response must remain replayable; only validated content becomes authoritative.
  o.ledger.saveBundle(bundle.id, persisted(candidate));
  if (result.missing.length) {
    o.ledger.recordBundleDelivery(bundle.id, result.delivered);
    const amount = result.delivered.reduce((sum, item) => sum + item.receipt.amount, 0);
    await verifyMissingSettlement(o, candidate, amount, readChannels);
  }
  o.ledger.finishBundle(bundle.id, result.delivered, result.missing);
}
async function consume(o: ChannelBuyerOptions, bundle: Bundle, response: Response, readChannels: ChannelReader): Promise<void> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Channel delivery pending (HTTP ${response.status})`); }
  const text = await response.text();
  if (text.length > 1048576) throw new Error('Bundle too large');
  const value: unknown = JSON.parse(text);
  const header = response.headers.get('PAYMENT-RESPONSE');
  await finishValidatedBundle(o, bundle, value, header, readChannels);
}
/** Recovery is limited and concurrent so dead channels cannot indefinitely block reconciliation. */
export async function recoverChannels(o: ChannelBuyerOptions, now = Date.now()): Promise<void> {
  const request = o.fetch ?? fetch;
  const readChannels = channelReader(o);
  await Promise.all(o.ledger.pendingBundles(MAX_RECOVERIES_PER_PASS, now).map(async row => {
    o.ledger.beginBundleAttempt(row.id, now);
    try {
      const bundle = restoreBundle(row.payload);
      if (bundle.value !== undefined) {
        await finishValidatedBundle(o, bundle, bundle.value, bundle.header ?? null, readChannels);
      } else if (bundle.paymentHeader) {
        // Replay resends the identical signed authorization (no new spend) to the configured forecaster.
        const path = new URL(bundle.url).pathname;
        if (path !== `/channels/reads/${bundle.id}`) throw new Error('Unexpected bundle path');
        const url = safeUrl(new URL(path, o.base).href, o.base);
        const response = await request(url, { headers: { 'PAYMENT-SIGNATURE': bundle.paymentHeader }, redirect: 'error', signal: AbortSignal.timeout(RECOVERY_TIMEOUT_MS) });
        await consume(o, bundle, response, readChannels);
      } else {
        // The authorization is persisted synchronously before transport. No header means no payment could be broadcast.
        o.ledger.finishBundle(bundle.id, [], bundle.items.map(x => x.listing.forecastPda));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Channel recovery failed; reservations retained';
      o.ledger.bundleError(row.id, reason);
    }
  }));
}
/** Call once per scan with policy-filtered listings across eligible markets, never during dry-run. */
export async function buyChannels(o: ChannelBuyerOptions, listings: ForecastListing[]): Promise<void> {
  const request = o.fetch ?? fetch;
  const readChannels = channelReader(o);
  const discovery = await request(new URL('/channels', o.base), { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (discovery.status === 404) return; // Explicit exact-only third-party API.
  if (!discovery.ok) throw new Error('Channel discovery unavailable');
  const capabilities = await discovery.json() as { scheme?: unknown; version?: unknown; maxReads?: unknown; quoteUrl?: unknown };
  if (capabilities.scheme !== 'upto' || capabilities.version !== 1 || capabilities.quoteUrl !== '/channels/quotes' || !Number.isInteger(capabilities.maxReads) || Number(capabilities.maxReads) < 2) throw new Error('Invalid channel discovery');
  const limit = Math.min(MAX_READS, Number(capabilities.maxReads));
  const groups = new Map<string, VerifiedListing[]>(), addresses = pdas(o.programId), seen = new Set<string>();
  for (const listing of listings) {
    if (seen.has(listing.forecastPda) || o.ledger.has('read', listing.forecastPda)) continue;
    seen.add(listing.forecastPda);
    try {
      const v = await verifyListing(o.program, listing, o.base, o.minReputationBps);
      const forecaster = addresses.forecaster(new PublicKey(v.recipient));
      if (forecaster.toBase58() !== listing.forecasterPda || addresses.forecast(forecaster, marketHash(listing.instrumentSymbol)).toBase58() !== listing.forecastPda) continue;
      const f = await o.program.fetchForecast(new PublicKey(listing.forecastPda));
      if (!f?.market.equals(addresses.market(marketHash(listing.instrumentSymbol)))) continue;
      const group = groups.get(v.recipient) ?? []; group.push(v); groups.set(v.recipient, group);
    } catch { /* Invalid listings cannot authorize spending. */ }
  }
  for (const group of groups.values()) for (let offset = 0; offset < group.length; offset += limit) {
    const items = group.slice(offset, offset + limit);
    if (items.length < 2) continue;
    const id = randomBytes(32).toString('hex');
    const bundle: Bundle = { id, url: new URL(`/channels/reads/${id}`, o.base).href, items };
    try {
      if (!o.ledger.reserveBundle(id, items.map(x => ({ key: x.listing.forecastPda, symbol: x.listing.instrumentSymbol, amount: x.amount })), persisted(bundle))) continue;
    } catch { continue; }
    try {
      const quoteResponse = await request(new URL('/channels/quotes', o.base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, forecasts: items.map(x => x.listing.forecastPda) }), redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!quoteResponse.ok) throw new Error('Quote unavailable');
      const quote = await quoteResponse.json() as { id: string; url: string; amount: string; recipient: string };
      if (quote.id !== id || safeUrl(quote.url, o.base) !== bundle.url || quote.amount !== String(items.reduce((n, x) => n + x.amount, 0)) || quote.recipient !== items[0]!.recipient) throw new Error('Untrusted bundle quote');
      const signer = await createKeyPairSignerFromBytes(o.wallet.secretKey);
      const client = new x402Client().register(DEVNET, new UptoSvmScheme(signer, { rpcUrl: o.rpcUrl, transactionVersions: [0] }));
      client.registerPolicy((_version, requirements) => requirements.filter(r => allowedChannelQuote(r, items, o.wallet.publicKey.toBase58())));
      const transport: typeof fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== bundle.url) throw new Error('Payment destination changed');
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        const payment = headers.get('PAYMENT-SIGNATURE');
        if (payment) {
          if (bundle.paymentHeader) throw new Error('Replacement payment blocked');
          bundle.paymentHeader = payment; o.ledger.saveBundle(id, persisted(bundle));
        }
        return request(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(90000) });
      };
      await consume(o, bundle, await wrapFetchWithPayment(transport, client)(bundle.url, { redirect: 'error' }), readChannels);
    } catch (error) {
      if (!bundle.paymentHeader) o.ledger.finishBundle(id, [], items.map(x => x.listing.forecastPda));
      else o.ledger.deferBundle(id, Date.now(), error instanceof Error ? error.message : 'Channel purchase pending; reservations retained');
    }
  }
}
