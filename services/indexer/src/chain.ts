import anchor from '@coral-xyz/anchor';
import type { Idl } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { readFileSync } from 'node:fs';
import { eventKind, normalizePayload, tokenReceipts, type Row } from './input.js';
import { Store, type NewEvent, type StoredEvent } from './store.js';
const { Program, AnchorProvider, BorshCoder, EventParser } = anchor;
type AccountRow = { publicKey: PublicKey; account: Record<string, unknown> };
type AccountClient = { all(): Promise<AccountRow[]> };
function text(x: unknown): string { return x instanceof PublicKey ? x.toBase58() : String(x); }
function json(x: unknown): unknown {
  if (x instanceof PublicKey) return x.toBase58();
  if (anchor.BN.isBN(x)) return String(x);
  if (typeof x === 'bigint') return x.toString();
  if (Buffer.isBuffer(x) || x instanceof Uint8Array) return Buffer.from(x).toString('hex');
  if (Array.isArray(x)) return x.map(json);
  if (x !== null && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, json(v)]));
  return x;
}
export class ChainIndexer {
  readonly rpc: Connection;
  readonly program: InstanceType<typeof Program>;
  readonly parser: InstanceType<typeof EventParser>;
  owners = new Set<string>();
  symbols = new Map<string, string>();
  forecastMarkets = new Map<string, string>();
  ready = false;
  constructor(readonly store: Store, readonly programId: PublicKey, rpcUrl: string, idlPath: string, readonly mint: string, readonly publish: (event: StoredEvent) => void) {
    this.rpc = new Connection(rpcUrl, 'finalized');
    const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as Idl;
    idl.address = programId.toBase58();
    // Read-only wallet: no keypair is loaded or generated; signing always fails closed.
    const provider = new AnchorProvider(this.rpc, {
      publicKey: PublicKey.default,
      signTransaction: async () => { throw new Error('Read-only provider'); },
      signAllTransactions: async () => { throw new Error('Read-only provider'); }
    }, { commitment: 'finalized' });
    this.program = new Program(idl, provider);
    this.parser = new EventParser(programId, new BorshCoder(this.program.idl));
  }
  async refresh(): Promise<void> {
    const accounts = this.program.account as unknown as Record<string, AccountClient>;
    if (!accounts.forecaster || !accounts.market) throw new Error('IDL missing forecaster or market account');
    const [forecasters, markets, forecasts] = await Promise.all([accounts.forecaster.all(), accounts.market.all(), accounts.forecast.all()]);
    const snapshot = forecasters.map(({ publicKey, account: a }) => ({ forecasterPda: publicKey.toBase58(), authority: text(a.authority), name: text(a.name), reputationBps: Number(a.reputationBps), scoredCount: Number(a.scoredCount), totalReads: Number(a.totalReads) }));
    if (snapshot.some(r => !Number.isFinite(r.reputationBps) || !Number.isFinite(r.scoredCount) || !Number.isFinite(r.totalReads))) throw new Error('Invalid chain snapshot');
    this.store.snapshot(snapshot);
    this.owners = new Set(snapshot.map(r => r.authority));
    this.symbols = new Map(markets.map(({ publicKey, account }) => [publicKey.toBase58(), text(account.instrumentSymbol)]));
    this.forecastMarkets = new Map(forecasts.map(({ publicKey, account }) => [publicKey.toBase58(), text(account.market)]));
    this.ready = true;
  }
  ingest(row: Row): void {
    if (!this.ready) throw new Error('Snapshot unavailable');
    if (this.store.has(row.signature)) return;
    if (row.err !== null) { this.store.ingest(row, []); return; }
    const entries: NewEvent[] = [];
    // EventParser tracks CPI invocation stacks and only decodes this program's logs.
    for (const event of this.parser.parseLogs(row.logMessages)) {
      const kind = eventKind(event.name);
      if (!kind) continue;
      const data = json(event.data) as Record<string, unknown>;
      const symbol = this.symbols.get(String(data.market ?? this.forecastMarkets.get(String(data.forecast))));
      if (symbol) data.instrumentSymbol = symbol;
      entries.push({ kind, data });
    }
    for (const receipt of tokenReceipts(row, this.mint, this.owners)) entries.push({ kind: 'usdc_transfer', data: { owner: receipt.owner, mint: this.mint, amountBaseUnits: receipt.amount.toString(), amountUsdc: Number(receipt.amount) / 1e6, attribution: 'transaction_net_balance_increase' } });
    for (const event of this.store.ingest(row, entries)) this.publish(event);
  }
  private async signatures(address: PublicKey, until: string | undefined): Promise<{ signature: string; slot: number }[]> {
    let before: string | undefined;
    const found: { signature: string; slot: number }[] = [];
    for (;;) {
      const page = await this.rpc.getSignaturesForAddress(address, { limit: 1000, ...(before ? { before } : {}), ...(until ? { until } : {}) }, 'finalized');
      if (!page.length) break;
      for (const s of page) {
        if (s.confirmationStatus !== 'finalized') throw new Error('RPC returned an unfinalized signature');
        found.push({ signature: s.signature, slot: s.slot });
      }
      before = page.at(-1)!.signature;
      if (page.length < 1000) break;
    }
    return found;
  }
  async poll(): Promise<void> {
    // x402 transfers do not invoke Delphi. Index recipient ATAs as well as the program.
    const addresses = [this.programId, ...[...this.owners].map(owner =>
      getAssociatedTokenAddressSync(new PublicKey(this.mint), new PublicKey(owner)))];
    for (const address of addresses) {
      const cursorKey = `rpcCursor:${address.toBase58()}`, pendingKey = `rpcPending:${address.toBase58()}`;
      const until = this.store.get(cursorKey);
      let signatures: { signature: string; slot: number }[];
      try { signatures = await this.signatures(address, until); }
      catch (error) {
        // A pruned cursor transaction makes `until` unusable; rescan from the tip. Dedup makes this safe.
        if (!until || !/not found/i.test(String(error))) throw error;
        signatures = await this.signatures(address, undefined);
      }
      // Transactions the RPC could not return yet are retried on later polls instead of blocking the cursor.
      const pending = JSON.parse(this.store.get(pendingKey) ?? '[]') as { signature: string; attempts: number }[];
      const retry = new Map(pending.map(p => [p.signature, p.attempts]));
      const newest = signatures[0]?.signature;
      const queue = [...pending.map(p => p.signature), ...signatures.reverse().map(s => s.signature)];
      const unresolved: { signature: string; attempts: number }[] = [];
      for (const signature of queue) {
        if (this.store.has(signature)) continue;
        const tx = await this.rpc.getParsedTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
        if (!tx) {
          const attempts = (retry.get(signature) ?? 0) + 1;
          if (attempts <= 5) unresolved.push({ signature, attempts });
          continue;
        }
        for (const row of normalizePayload(tx)) this.ingest(row);
      }
      this.store.set(pendingKey, JSON.stringify(unresolved));
      if (newest) this.store.set(cursorKey, newest);
    }
    this.store.set('rpcPollAt', String(Date.now()));
  }
}
