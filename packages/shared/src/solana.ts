import anchor from '@coral-xyz/anchor';
import type { Idl, Program as ProgramType } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, type Env } from './config.js';
const { Program, AnchorProvider, Wallet, BN, BorshCoder, EventParser } = anchor;
export { BorshCoder, EventParser };
export type ForecasterAccount = { authority: PublicKey; name: string; pricePerRead: bigint; totalForecasts: number; totalReads: number; scoredCount: number; brierSumBps: bigint; reputationBps: number };
export type ForecastAccount = { forecaster: PublicKey; market: PublicKey; commitment: Uint8Array; pricePerRead: bigint; postedAt: number; reads: number; revealed: boolean; probBps: number; brierBps: number };
export type MarketAccount = { marketHash: Uint8Array; instrumentSymbol: string; resolved: boolean; outcomeYes: boolean; resolvedAt: number };
export function loadKeypair(path: string): Keypair {
  let bytes: unknown;
  try { bytes = JSON.parse(readFileSync(resolve(REPO_ROOT, path), 'utf8')); } catch { throw new Error('Unable to read Solana keypair file'); }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('Solana keypair must contain 64 bytes');
  try { return Keypair.fromSecretKey(Uint8Array.from(bytes)); } catch { throw new Error('Invalid Solana keypair'); }
}
export function connection(env: Env): Connection { return new Connection(env.SOLANA_RPC_URL, 'confirmed'); }
export function marketHash(instrumentSymbol: string): Uint8Array { return createHash('sha256').update(instrumentSymbol, 'utf8').digest(); }
function bytes(value: Uint8Array, length: number): Buffer { if (value.length !== length) throw new RangeError(`Expected ${length} bytes`); return Buffer.from(value); }
export function commitment(probBps: number, salt: Uint8Array): Uint8Array {
  if (!Number.isInteger(probBps) || probBps < 0 || probBps > 10000) throw new RangeError('Invalid probability basis points');
  const p = Buffer.alloc(2); p.writeUInt16LE(probBps);
  return createHash('sha256').update(p).update(bytes(salt, 32)).digest();
}
export function randomSalt(): Uint8Array { return randomBytes(32); }
export function pdas(programId: PublicKey) {
  const derive = (tag: string, ...seeds: Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(tag), ...seeds], programId)[0];
  return {
    config: () => derive('config'), forecaster: (auth: PublicKey) => derive('forecaster', auth.toBuffer()),
    market: (hash: Uint8Array) => derive('market', bytes(hash, 32)),
    forecast: (forecasterPda: PublicKey, hash: Uint8Array) => derive('forecast', forecasterPda.toBuffer(), bytes(hash, 32)),
    purchase: (forecastPda: PublicKey, buyer: PublicKey) => derive('purchase', forecastPda.toBuffer(), buyer.toBuffer()),
  };
}
type Raw = Record<string, unknown>;
type Builder = { accountsStrict(accounts: Record<string, PublicKey>): { rpc(): Promise<string> } };
type Methods = Record<string, (...args: unknown[]) => Builder>;
function integer(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'object' && value !== null && BN.isBN(value)) return BigInt(value.toString());
  throw new Error('Invalid on-chain integer');
}
function number(value: unknown): number { const n = Number(integer(value)); if (!Number.isSafeInteger(n)) throw new Error('Unsafe on-chain integer'); return n; }
function key(value: unknown): PublicKey { if (!(value instanceof PublicKey)) throw new Error('Invalid on-chain public key'); return value; }
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('Invalid on-chain string'); return value; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('Invalid on-chain boolean'); return value; }
function array(value: unknown): Uint8Array { if (!Array.isArray(value) && !(value instanceof Uint8Array)) throw new Error('Invalid on-chain bytes'); return bytes(Uint8Array.from(value), 32); }
function forecaster(a: Raw): ForecasterAccount { return { authority: key(a.authority), name: text(a.name), pricePerRead: integer(a.pricePerRead), totalForecasts: number(a.totalForecasts), totalReads: number(a.totalReads), scoredCount: number(a.scoredCount), brierSumBps: integer(a.brierSumBps), reputationBps: number(a.reputationBps) }; }
function forecast(a: Raw): ForecastAccount { return { forecaster: key(a.forecaster), market: key(a.market), commitment: array(a.commitment), pricePerRead: integer(a.pricePerRead), postedAt: number(a.postedAt), reads: number(a.reads), revealed: bool(a.revealed), probBps: number(a.probBps), brierBps: number(a.brierBps) }; }
function market(a: Raw): MarketAccount { return { marketHash: array(a.marketHash), instrumentSymbol: text(a.instrumentSymbol), resolved: bool(a.resolved), outcomeYes: bool(a.outcomeYes), resolvedAt: number(a.resolvedAt) }; }
function u64(value: bigint): InstanceType<typeof BN> { if (value < 0n || value > 18446744073709551615n) throw new RangeError('Value outside u64'); return new BN(value.toString()); }
export class DelphiProgram {
  readonly provider: InstanceType<typeof AnchorProvider>;
  readonly program: ProgramType<Idl>;
  readonly idl: Idl;
  readonly programId: PublicKey;
  private readonly addresses: ReturnType<typeof pdas>;
  private readonly authority: PublicKey;
  constructor(conn: Connection, wallet: Keypair, programId: PublicKey, idlPath = 'packages/shared/idl/delphi.json') {
    this.programId = programId; this.authority = wallet.publicKey; this.addresses = pdas(programId);
    let idl: Idl;
    try { idl = JSON.parse(readFileSync(resolve(REPO_ROOT, idlPath), 'utf8')) as Idl; } catch { throw new Error('Cannot load Delphi IDL; Main must supply packages/shared/idl/delphi.json'); }
    if (!Array.isArray(idl.instructions) || !Array.isArray(idl.accounts)) throw new Error('Invalid Delphi IDL');
    this.idl = { ...idl, address: programId.toBase58() };
    this.provider = new AnchorProvider(conn, new Wallet(wallet), { commitment: 'confirmed', preflightCommitment: 'confirmed' });
    this.program = new Program(this.idl, this.provider);
  }
  private send(name: string, args: unknown[], accounts: Record<string, PublicKey>): Promise<string> {
    const fn = (this.program.methods as unknown as Methods)[name];
    if (!fn) throw new Error(`IDL lacks instruction ${name}`);
    return fn(...args).accountsStrict(accounts).rpc();
  }
  private async fetch<T>(name: string, address: PublicKey, decode: (a: Raw) => T): Promise<T | null> {
    const info = await this.provider.connection.getAccountInfo(address, 'confirmed');
    if (info === null) return null;
    if (!info.owner.equals(this.programId)) throw new Error('Account is not owned by Delphi program');
    return decode(this.program.coder.accounts.decode(name, info.data) as Raw);
  }
  private async all<T>(name: string, decode: (a: Raw) => T): Promise<{ pubkey: PublicKey; account: T }[]> {
    const clients = this.program.account as unknown as Record<string, { all(): Promise<{ publicKey: PublicKey; account: Raw }[]> }>;
    if (!clients[name]) throw new Error(`IDL lacks account ${name}`);
    return (await clients[name].all()).map(row => ({ pubkey: row.publicKey, account: decode(row.account) }));
  }
  initialize(): Promise<string> { return this.send('initialize', [], { config: this.addresses.config(), authority: this.authority, systemProgram: SystemProgram.programId }); }
  registerForecaster(name: string, pricePerRead: bigint): Promise<string> {
    if (Buffer.byteLength(name) > 32) throw new RangeError('Forecaster name exceeds 32 bytes');
    return this.send('registerForecaster', [name, u64(pricePerRead)], { forecaster: this.addresses.forecaster(this.authority), authority: this.authority, systemProgram: SystemProgram.programId });
  }
  updateForecaster(pricePerRead: bigint): Promise<string> { return this.send('updateForecaster', [u64(pricePerRead)], { forecaster: this.addresses.forecaster(this.authority), authority: this.authority }); }
  async initMarket(instrumentSymbol: string): Promise<string> {
    if (Buffer.byteLength(instrumentSymbol) > 64) throw new RangeError('Symbol exceeds 64 bytes');
    if (await this.fetchMarket(instrumentSymbol)) return '';
    try { return await this.send('initMarket', [instrumentSymbol], { market: this.addresses.market(marketHash(instrumentSymbol)), payer: this.authority, systemProgram: SystemProgram.programId }); }
    catch (error) { if (await this.fetchMarket(instrumentSymbol)) return ''; throw error; }
  }
  postForecast(instrumentSymbol: string, hash: Uint8Array): Promise<string> {
    const forecaster = this.addresses.forecaster(this.authority), mh = marketHash(instrumentSymbol);
    return this.send('postForecast', [Array.from(bytes(hash, 32))], { forecast: this.addresses.forecast(forecaster, mh), forecaster, market: this.addresses.market(mh), authority: this.authority, systemProgram: SystemProgram.programId });
  }
  async recordPurchase(forecastPda: PublicKey, amount: bigint, paymentSig: Uint8Array): Promise<string> {
    const f = await this.fetchForecast(forecastPda); if (!f) throw new Error('Forecast account does not exist');
    return this.send('recordPurchase', [u64(amount), Array.from(bytes(paymentSig, 64))], { purchase: this.addresses.purchase(forecastPda, this.authority), forecast: forecastPda, forecaster: f.forecaster, market: f.market, buyer: this.authority, systemProgram: SystemProgram.programId });
  }
  resolveMarket(instrumentSymbol: string, outcomeYes: boolean): Promise<string> {
    return this.send('resolveMarket', [outcomeYes], { config: this.addresses.config(), market: this.addresses.market(marketHash(instrumentSymbol)), authority: this.authority });
  }
  async revealAndScore(forecastPda: PublicKey, probBps: number, salt: Uint8Array): Promise<string> {
    commitment(probBps, salt);
    const f = await this.fetchForecast(forecastPda); if (!f) throw new Error('Forecast account does not exist');
    return this.send('revealAndScore', [probBps, Array.from(bytes(salt, 32))], { forecast: forecastPda, forecaster: f.forecaster, market: f.market });
  }
  fetchForecaster(auth: PublicKey): Promise<ForecasterAccount | null> { return this.fetch('forecaster', this.addresses.forecaster(auth), forecaster); }
  fetchForecast(pda: PublicKey): Promise<ForecastAccount | null> { return this.fetch('forecast', pda, forecast); }
  fetchMarket(symbol: string): Promise<MarketAccount | null> { return this.fetch('market', this.addresses.market(marketHash(symbol)), market); }
  allForecasters(): Promise<{ pubkey: PublicKey; account: ForecasterAccount }[]> { return this.all('forecaster', forecaster); }
  allMarkets(): Promise<{ pubkey: PublicKey; account: MarketAccount }[]> { return this.all('market', market); }
  async forecastsForMarket(symbol: string): Promise<{ pubkey: PublicKey; account: ForecastAccount }[]> {
    const address = this.addresses.market(marketHash(symbol));
    const clients = this.program.account as unknown as Record<string, { all(filters: { memcmp: { offset: number; bytes: string } }[]): Promise<{ publicKey: PublicKey; account: Raw }[]> }>;
    const rows = await clients.forecast.all([{ memcmp: { offset: 8 + 32, bytes: address.toBase58() } }]);
    return rows.map(row => ({ pubkey: row.publicKey, account: forecast(row.account) }));
  }
}
