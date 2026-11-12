import { PublicKey, type Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { GeminiClient, DelphiProgram, pdas, marketHash, pooledForecast, log, type Env, type ForecastListing, type AgentTelemetry, type GeminiContract } from '@delphi/shared';
import { Ledger, orderPlan, units, safeUrl } from './guardrails.js';
import { paidRead, verifyListing, validateReceipt, type VerifiedListing, type Receipt } from './x402.js';
import { approve } from './approval.js';

export type Options = { env:Env; ledger:Ledger; gemini:GeminiClient; program?:DelphiProgram; wallet?:Keypair; programId?:PublicKey; allowLive:boolean; feeBps:number };
type Stored = { verified: VerifiedListing; value:unknown; header:string|null };
export class Buyer {
  constructor(readonly o:Options) {}
  async emit(stage:AgentTelemetry['stage'],detail:Record<string,unknown>,instrumentSymbol?:string):Promise<void> {
    const event:AgentTelemetry = {ts:Date.now(),stage,detail,...(instrumentSymbol?{instrumentSymbol}:{})};
    log(stage==='error'?'error':'info','buyer',event);
    // Do not log response bodies, exceptions, payment headers, keys, or reveal salts.
    try { await fetch(new URL('/telemetry',this.o.env.INDEXER_URL),{method:'POST',headers:{'Content-Type':'application/json','x-streams-secret':this.o.env.STREAMS_WEBHOOK_SECRET},body:JSON.stringify(event),redirect:'error',signal:AbortSignal.timeout(3000)}); } catch { /* Telemetry outages cannot authorize spending. */ }
  }
  private restored(rowPayload:string):Receipt {
    const s = JSON.parse(rowPayload) as Stored;
    // Uint8Array JSON serialization is an object, so the durable record stores bytes as an array.
    s.verified.commitment = Uint8Array.from(Object.values(s.verified.commitment));
    return validateReceipt(s.verified,s.value,s.header);
  }
  async reconcile():Promise<void> {
    const {program,env,ledger}=this.o;
    if (!program || env.BUYER_DRY_RUN) return;
    for (const row of ledger.reads()) {
      try {
        const receipt = this.restored(row.payload!);
        const pda = new PublicKey(row.key);
        if (!row.recorded) {
          // recordPurchase is PDA-unique. An ambiguous RPC may safely be retried; no HTTP payment is repeated.
          const purchase = pdas(this.o.programId!).purchase(pda,this.o.wallet!.publicKey);
          const { connection } = await import('@delphi/shared');
          const info = await connection(env).getAccountInfo(purchase,'confirmed');
          if (info) {
            if (!info.owner.equals(this.o.programId!)) throw new Error('Invalid purchase owner');
          } else await program.recordPurchase(pda,BigInt(receipt.amount),bs58.decode(receipt.paymentSig));
          ledger.mark(row.key,'recorded');
        }
        if (!row.revealed) {
          const m = await program.fetchMarket(row.symbol);
          if (!m?.resolved) continue;
          const f = await program.fetchForecast(pda);
          if (!f) throw new Error('Missing forecast');
          if (!f.revealed) await program.revealAndScore(pda,receipt.paid.probBps,Buffer.from(receipt.paid.salt,'hex'));
          ledger.mark(row.key,'revealed');
        }
      } catch { await this.emit('error',{operation:'reconcile',status:'retained_for_retry'},row.symbol); }
    }
  }
  private async listings(symbol:string):Promise<ForecastListing[]> {
    const url=new URL('/forecasts',this.o.env.FORECASTER_URL); url.searchParams.set('symbol',symbol);
    const res=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!res.ok) throw new Error('Listings unavailable');
    const body:unknown=await res.json();
    if (!Array.isArray(body) || body.length>10000) throw new Error('Invalid listings');
    return body.filter((v):v is ForecastListing=> !!v && typeof v==='object' && typeof v.forecastPda==='string' && typeof v.forecasterAuthority==='string' && typeof v.url==='string' && v.instrumentSymbol===symbol && Number.isFinite(v.pricePerReadUsdc) && v.pricePerReadUsdc>0 && Number.isInteger(v.reputationBps) && v.reputationBps>=this.o.env.BUYER_MIN_FORECASTER_REPUTATION_BPS && v.reputationBps<=10000 && v.pricePerReadUsdc<=this.o.env.BUYER_MAX_READ_PRICE_USDC).sort((a,b)=>b.reputationBps-a.reputationBps);
  }
  private async market(c:GeminiContract):Promise<void> {
    const {env,ledger,program,wallet,programId,gemini}=this.o, symbol=c.instrumentSymbol;
    const listings=await this.listings(symbol);
    if (env.BUYER_DRY_RUN) {
      await this.emit('skip',{reason:'dry_run_no_payments_or_trades',listings:listings.map(l=>({forecastPda:l.forecastPda,pricePerReadUsdc:l.pricePerReadUsdc,reputationBps:l.reputationBps}))},symbol); return;
    }
    if (!program || !wallet || !programId) { await this.emit('skip',{reason:'solana_not_configured'},symbol); return; }
    const identities=new Set<string>(), forecasts:{prob:number;reputationBps:number}[]=[];
    const addresses=pdas(programId);
    for (const l of listings) {
      if (identities.has(l.forecasterAuthority)) continue;
      try {
        safeUrl(l.url,env.FORECASTER_URL);
        const v=await verifyListing(program,l,env.FORECASTER_URL);
        const forecaster=addresses.forecaster(new PublicKey(l.forecasterAuthority));
        if (forecaster.toBase58()!==l.forecasterPda || addresses.forecast(forecaster,marketHash(symbol)).toBase58()!==l.forecastPda) throw new Error('Incorrect listing PDA');
        const f=await program.fetchForecast(new PublicKey(l.forecastPda));
        if (!f?.market.equals(addresses.market(marketHash(symbol)))) throw new Error('Incorrect market linkage');
        let receipt:Receipt|undefined;
        if (ledger.has('read',l.forecastPda)) {
          const cached=ledger.reads().find(r=>r.key===l.forecastPda);
          if (cached?.payload) receipt=this.restored(cached.payload);
        } else if (ledger.reserve('read',l.forecastPda,symbol,v.amount)) {
          await this.emit('buy',{forecastPda:l.forecastPda,reservedUsdc:v.amount/1e6},symbol);
          receipt=await paidRead(wallet,env.SOLANA_RPC_URL,v,(value,header)=>ledger.saveRead(l.forecastPda,{verified:{...v,commitment:Array.from(v.commitment)},value,header}));
        }
        if (receipt) { identities.add(l.forecasterAuthority); forecasts.push({prob:receipt.paid.probBps/10000,reputationBps:v.listing.reputationBps}); }
      } catch { await this.emit('error',{operation:'read',status:'blocked_or_reservation_retained'},symbol); }
    }
    await this.reconcile();
    if (!forecasts.length) { await this.emit('skip',{reason:'no_verified_forecasts'},symbol); return; }
    const pooled=pooledForecast(forecasts);
    await this.emit('aggregate',{probability:pooled.prob,count:forecasts.length},symbol);
    if (ledger.has('trade',symbol)) { await this.emit('skip',{reason:'symbol_already_reserved'},symbol); return; }
    // Refresh executable quotes after paid reads, before sizing and authorization.
    const events=await gemini.listEvents({status:['active'],limit:100,offset:0});
    const fresh=events.data.flatMap(e=>e.contracts).find(x=>x.instrumentSymbol===symbol);
    if (!fresh || fresh.status!=='active') return;
    const remaining=ledger.remaining(symbol)/1e6;
    const first=orderPlan(fresh,pooled.prob,Math.min(remaining,env.BUYER_MAX_POSITION_USDC),this.o.feeBps);
    if (!first || first.edge<env.BUYER_EDGE_THRESHOLD) { await this.emit('skip',{reason:'insufficient_executable_edge'},symbol); return; }
    const price=Number(first.price), kelly=Math.min(0.25,Math.max(0,first.edge/(1-price)));
    const plan=orderPlan(fresh,pooled.prob,Math.min(remaining,env.BUYER_MAX_POSITION_USDC,kelly*env.BUYER_PER_MARKET_BUDGET_USDC),this.o.feeBps);
    if (!plan || plan.edge<env.BUYER_EDGE_THRESHOLD) return;
    await this.emit('decide',{side:plan.side,edge:plan.edge,reservedUsdc:plan.reserve/1e6},symbol);
    if (!env.GEMINI_API_KEY || !env.GEMINI_API_SECRET) { await this.emit('skip',{reason:'gemini_credentials_missing'},symbol); return; }
    const privateUrl=new URL(env.GEMINI_API_BASE);
    if (privateUrl.protocol!=='https:' || privateUrl.username || privateUrl.password || !['api.sandbox.gemini.com','api.gemini.com'].includes(privateUrl.hostname) || (privateUrl.hostname==='api.gemini.com' && !this.o.allowLive)) { await this.emit('skip',{reason:'private_api_blocked'},symbol); return; }
    if (!(await gemini.termsStatus()).hasAcceptedLatest) { await this.emit('skip',{reason:'gemini_terms_require_manual_acceptance'},symbol); return; }
    const size=plan.reserve/1e6;
    if (size>=env.BUYER_VOICE_APPROVE_ABOVE_USDC) {
      await this.emit('approve',{mode:'human',size},symbol);
      if (!await approve({apiKey:env.ELEVENLABS_API_KEY,agentId:env.ELEVENLABS_AGENT_ID,phoneId:env.ELEVENLABS_PHONE_NUMBER_ID,to:env.APPROVER_PHONE_NUMBER},{symbol,side:plan.side,size,edge:plan.edge})) { await this.emit('skip',{reason:'approval_denied'},symbol); return; }
    } else if (size>=env.BUYER_AUTO_APPROVE_BELOW_USDC) await this.emit('approve',{mode:'notify',size},symbol);
    // The approved limit remains unchanged even if the market moves during the call.
    const expiry=Date.parse(fresh.expiryDate ?? '');
    if (!Number.isFinite(expiry) || expiry-Date.now()<120000 || !ledger.reserve('trade',symbol,symbol,plan.reserve)) return;
    try {
      const order=await gemini.placeOrder({symbol,side:'buy',outcome:plan.side,quantity:plan.quantity,price:plan.price,orderType:'limit',timeInForce:'immediate-or-cancel'});
      if (!Number.isSafeInteger(order.orderId)) throw new Error('Invalid order receipt');
      ledger.tradeResult(symbol,order.orderId);
      await this.emit('trade',{orderId:order.orderId,status:order.status},symbol);
    } catch { await this.emit('error',{operation:'trade',status:'uncertain_reservation_retained_no_retry'},symbol); }
  }
  async tick():Promise<void> {
    await this.reconcile();
    await this.emit('scan',{});
    const seen=new Set<string>();
    // Bounded pagination prevents an upstream pagination bug from creating an unbounded tick.
    for (let offset=0;offset<1000;offset+=100) {
      const page=await this.o.gemini.listEvents({status:['active'],limit:100,offset});
      for (const event of page.data) {
        if (event.type!=='binary') continue;
        for (const c of event.contracts) {
          const ttl=Date.parse(c.expiryDate ?? event.expiryDate ?? '')-Date.now();
          if (seen.has(c.instrumentSymbol) || c.status!=='active' || !Number.isFinite(ttl) || ttl<120000 || ttl>86400000 || (c.prices.bestAsk===null && c.prices.bestBid===null)) continue;
          seen.add(c.instrumentSymbol);
          try { await this.market(c); } catch { await this.emit('error',{operation:'market',status:'blocked'},c.instrumentSymbol); }
        }
      }
      if (!page.data.length || offset+100>=page.pagination.total) break;
    }
  }
}
