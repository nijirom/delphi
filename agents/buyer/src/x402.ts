import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { PublicKey, type Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { timingSafeEqual } from 'node:crypto';
import { commitment, type DelphiProgram, type ForecastListing, type PaidForecast } from '@delphi/shared';
import { DEVNET, DEVNET_USDC, safeUrl, units } from './guardrails.js';

export type VerifiedListing = { listing: ForecastListing; url: string; amount: number; recipient: string; commitment: Uint8Array };
export type Receipt = { paid: PaidForecast; paymentSig: string; amount: number; recipient: string; reputationBps: number };
export async function verifyListing(program: DelphiProgram, l: ForecastListing, base: string): Promise<VerifiedListing> {
  const url = safeUrl(l.url,base);
  const f = await program.fetchForecast(new PublicKey(l.forecastPda));
  const a = await program.fetchForecaster(new PublicKey(l.forecasterAuthority));
  const m = await program.fetchMarket(l.instrumentSymbol);
  if (!f || !a || !m || m.resolved || f.revealed || a.authority.toBase58() !== l.forecasterAuthority || f.forecaster.toBase58() !== l.forecasterPda) throw new Error('Listing does not match chain');
  // PDA linkage to the instrument is checked by the caller using its configured program ID.
  const amount = units(l.pricePerReadUsdc);
  if (BigInt(amount) !== f.pricePerRead || BigInt(amount) !== a.pricePerRead || amount <= 0 || l.reputationBps !== a.reputationBps) throw new Error('Listing price or reputation mismatch');
  return { listing:l, url, amount, recipient:a.authority.toBase58(), commitment:f.commitment };
}
export function validateReceipt(v: VerifiedListing, value: unknown, header: string | null): Receipt {
  if (!value || typeof value !== 'object') throw new Error('Invalid forecast response');
  const p = value as PaidForecast;
  if (p.forecastPda !== v.listing.forecastPda || p.instrumentSymbol !== v.listing.instrumentSymbol || !Number.isInteger(p.probBps) || p.probBps < 0 || p.probBps > 10000 || typeof p.salt !== 'string' || !/^[a-fA-F0-9]{64}$/.test(p.salt) || typeof p.rationale !== 'string' || typeof p.forecasterName !== 'string') throw new Error('Invalid forecast payload');
  const actual = commitment(p.probBps,Buffer.from(p.salt,'hex'));
  if (actual.length !== v.commitment.length || !timingSafeEqual(actual,v.commitment)) throw new Error('Forecast commitment mismatch');
  if (!header || header.length > 16384) throw new Error('Settlement receipt missing');
  const settlement = JSON.parse(Buffer.from(header,'base64').toString('utf8')) as {success?:unknown;transaction?:unknown;network?:unknown};
  if (settlement.success !== true || typeof settlement.transaction !== 'string' || (settlement.network !== undefined && settlement.network !== DEVNET)) throw new Error('Settlement not successful');
  const bytes = bs58.decode(settlement.transaction);
  if (bytes.length !== 64 || bytes.every(b=>b===0)) throw new Error('Invalid settlement signature');
  return { paid:p, paymentSig:settlement.transaction, amount:v.amount, recipient:v.recipient, reputationBps:v.listing.reputationBps };
}
export async function paidRead(wallet: Keypair, rpcUrl: string, v: VerifiedListing, persistRaw: (value: unknown,header:string|null)=>void): Promise<Receipt> {
  const signer = await createKeyPairSignerFromBytes(wallet.secretKey);
  const client = new x402Client();
  client.register(DEVNET,new ExactSvmScheme(signer,{rpcUrl,transactionVersions:[0]}));
  client.registerPolicy((_version,requirements)=>requirements.filter(r=>r.scheme==='exact' && r.network===DEVNET && r.asset===DEVNET_USDC && r.payTo===v.recipient && /^[0-9]+$/.test(r.amount) && BigInt(r.amount)===BigInt(v.amount)));
  // A separate client and one-use payment transport per reservation prevent retries from spending twice.
  let signedRequests = 0;
  const transport: typeof fetch = async (input,init) => {
    const h = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value,key)=>h.set(key,value));
    if (h.has('PAYMENT-SIGNATURE') || h.has('X-PAYMENT')) {
      if (++signedRequests > 1) throw new Error('Repeated paid request blocked');
    }
    const url = input instanceof Request ? input.url : String(input);
    if (url !== v.url) throw new Error('Payment destination changed');
    return fetch(input,{...init,redirect:'error',signal:AbortSignal.timeout(45000)});
  };
  const response = await wrapFetchWithPayment(transport,client)(v.url,{redirect:'error'});
  const header = response.headers.get('PAYMENT-RESPONSE');
  const text = await response.text();
  if (text.length > 262144) throw new Error('Forecast response too large');
  const value: unknown = JSON.parse(text);
  // Persist the reveal before validation or any on-chain transaction. Invalid receipts remain quarantined.
  persistRaw(value,header);
  if (!response.ok) throw new Error('Paid read failed');
  return validateReceipt(v,value,header);
}
