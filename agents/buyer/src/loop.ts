import { PublicKey, type Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { GeminiClient, DelphiProgram, pdas, marketHash, midPrice, pooledForecast, log, type Env, type ForecastListing, type AgentTelemetry, type GeminiContract, type GeminiEvent } from '@delphi/shared';
import { Ledger, orderPlan, hasQuotableBook, units, safeUrl } from './guardrails.js';
import { paidRead, verifyListing, validateReceipt, ReadFailed, type VerifiedListing, type Receipt } from './x402.js';
import { approve } from './approval.js';
import { buyChannels, recoverChannels } from './channels.js';

export type Options = { env:Env; ledger:Ledger; gemini:GeminiClient; program?:DelphiProgram; wallet?:Keypair; programId?:PublicKey; allowLive:boolean; feeBps:number; paymentScheme?:'upto'|'exact' };
type Stored = { verified: VerifiedListing; value:unknown; header:string|null };
export class Buyer {
  private readonly dryRunLogged = new Map<string, number>();
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
    if (this.o.wallet && this.o.programId) await recoverChannels({ base:env.FORECASTER_URL, rpcUrl:env.SOLANA_RPC_URL, wallet:this.o.wallet, program, programId:this.o.programId, ledger });
    for (const row of ledger.reads()) {
      let receipt:Receipt;
      // A payload that cannot validate never will: quarantine it instead of failing every tick forever.
      try { receipt = this.restored(row.payload!); }
      catch { ledger.quarantine(row.key); await this.emit('error',{operation:'reconcile',status:'payload_quarantined'},row.symbol); continue; }
      const pda = new PublicKey(row.key);
      const resolved = await program.fetchMarket(row.symbol).then(m=>m?.resolved ?? null).catch(()=>null);
      if (!row.recorded) {
        try {
          // recordPurchase is PDA-unique. An ambiguous RPC may safely be retried; no HTTP payment is repeated.
          if (await program.hasPurchase(pda,this.o.wallet!.publicKey)) {
            // Already recorded on an earlier pass whose confirmation was lost.
          } else if (resolved) {
            // The program rejects record_purchase once the market resolves; retrying it forever would also block the reveal.
            log('warn','Purchase cannot be recorded after resolution',{forecastPda:row.key});
          } else await program.recordPurchase(pda,BigInt(receipt.amount),bs58.decode(receipt.paymentSig));
          ledger.mark(row.key,'recorded');
        } catch { await this.emit('error',{operation:'record_purchase',status:'retained_for_retry'},row.symbol); }
      }
      // The reveal is what scores the forecast; it must not depend on the purchase record landing.
      if (!row.revealed && resolved) {
        try {
          const f = await program.fetchForecast(pda);
          if (!f) throw new Error('Missing forecast');
          if (f.forfeited) log('info','Purchased forecast was forfeited',{forecastPda:row.key});
          else if (!f.revealed) await program.revealAndScore(pda,receipt.paid.probBps,Buffer.from(receipt.paid.salt,'hex'));
          ledger.mark(row.key,'revealed');
        } catch { await this.emit('error',{operation:'reveal',status:'retained_for_retry'},row.symbol); }
      }
    }
  }
  private async listings():Promise<ForecastListing[]> {
    const url=new URL('/forecasts',this.o.env.FORECASTER_URL);
    let res:Response;
    try { res=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)}); }
    catch { throw new Error('forecaster_unreachable'); }
    if (!res.ok) { await res.body?.cancel(); throw new Error(`forecaster_http_${res.status}`); }
    let body:unknown;
    try { body=await res.json(); } catch { throw new Error('forecaster_invalid_response'); }
    if (!Array.isArray(body) || body.length>10000) throw new Error('forecaster_invalid_response');
    return body.filter((v):v is ForecastListing=> !!v && typeof v==='object' && typeof v.forecastPda==='string' && typeof v.forecasterAuthority==='string' && typeof v.url==='string' && typeof v.instrumentSymbol==='string' && Number.isFinite(v.pricePerReadUsdc) && v.pricePerReadUsdc>0 && Number.isInteger(v.reputationBps) && v.reputationBps>=this.o.env.BUYER_MIN_FORECASTER_REPUTATION_BPS && v.reputationBps<=10000 && v.pricePerReadUsdc<=this.o.env.BUYER_MAX_READ_PRICE_USDC).sort((a,b)=>b.reputationBps-a.reputationBps);
  }
  private async market(c:GeminiContract,listings:ForecastListing[]):Promise<void> {
    const {env,ledger,program,wallet,programId,gemini}=this.o, symbol=c.instrumentSymbol;
    if (env.BUYER_DRY_RUN) {
      const now=Date.now(), prev=this.dryRunLogged.get(symbol);
      if (prev===undefined || (now-prev>=600000 && listings.length>0)) {
        this.dryRunLogged.set(symbol,now);
        await this.emit('skip',{reason:'dry_run_no_payments_or_trades',count:listings.length,topReputationBps:listings[0]?.reputationBps??null,mid:midPrice(c),listings:listings.map(l=>({forecastPda:l.forecastPda,pricePerReadUsdc:l.pricePerReadUsdc,reputationBps:l.reputationBps}))},symbol);
      }
      return;
    }
    if (!program || !wallet || !programId) { await this.emit('skip',{reason:'solana_not_configured'},symbol); return; }
    if (!hasQuotableBook(c, this.o.feeBps)) { await this.emit('skip', { reason: 'unquotable_contract' }, symbol); return; }
    const identities=new Set<string>(), forecasts:{prob:number;reputationBps:number}[]=[];
    const addresses=pdas(programId);
    for (const l of listings) {
      if (identities.has(l.forecasterAuthority)) continue;
      try {
        safeUrl(l.url,env.FORECASTER_URL);
        const v=await verifyListing(program,l,env.FORECASTER_URL,env.BUYER_MIN_FORECASTER_REPUTATION_BPS);
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
          try {
            receipt=await paidRead(wallet,env.SOLANA_RPC_URL,v,(value,header)=>ledger.saveRead(l.forecastPda,{verified:{...v,commitment:Array.from(v.commitment)},value,header}));
          } catch (e) {
            // Hold the reservation whenever a signed request reached the transport; release only a proven pre-transmission failure.
            if (e instanceof ReadFailed && !e.transmitted) ledger.release('read',l.forecastPda);
            throw e;
          }
        }
        if (receipt) { identities.add(l.forecasterAuthority); forecasts.push({prob:receipt.paid.probBps/10000,reputationBps:v.listing.reputationBps}); }
      } catch (e) { await this.emit('error',{operation:'read',status:e instanceof ReadFailed && !e.transmitted ? 'unpaid_reservation_released' : 'blocked_or_reservation_retained',reason:e instanceof Error?e.message.replace(/https?:\/\/\S+/g,'[URL]').slice(0,100):'unknown'},symbol); }
    }
    if (!forecasts.length) { await this.emit('skip',{reason:'no_verified_forecasts'},symbol); return; }
    const pooled=pooledForecast(forecasts);
    await this.emit('aggregate',{probability:pooled.prob,count:forecasts.length},symbol);
    if (ledger.has('trade',symbol)) { await this.emit('skip',{reason:'symbol_already_reserved'},symbol); return; }
    // Refresh executable quotes after paid reads, before sizing and authorization.
    if (!c.eventTicker) { await this.emit('skip',{reason:'market_parent_unknown'},symbol); return; }
    let event:GeminiEvent;
    try { event=await gemini.getEvent(c.eventTicker); }
    catch { await this.emit('skip',{reason:'market_refresh_unavailable'},symbol); return; }
    if (event.ticker!==c.eventTicker || event.type!=='binary' || event.status!=='active' || event.resolvedAt) { await this.emit('skip',{reason:'market_not_active_binary'},symbol); return; }
    const fresh=event.contracts.find(x=>x.instrumentSymbol===symbol);
    if (!fresh || fresh.status!=='active' || fresh.resolutionSide || fresh.resolvedAt) { await this.emit('skip',{reason:'contract_unavailable'},symbol); return; }
    const expiry=Date.parse(fresh.expiryDate ?? event.expiryDate ?? '');
    if (!Number.isFinite(expiry) || expiry-Date.now()<120000) { await this.emit('skip',{reason:'market_expired_or_expiry_unknown'},symbol); return; }
    const remaining=ledger.remaining(symbol)/1e6;
    const first=orderPlan(fresh,pooled.prob,Math.min(remaining,env.BUYER_MAX_POSITION_USDC),this.o.feeBps);
    if (!first || first.edge<env.BUYER_EDGE_THRESHOLD) { await this.emit('skip',{reason:'insufficient_executable_edge'},symbol); return; }
    const price=Number(first.price), kelly=Math.min(0.25,Math.max(0,first.edge/(1-price)));
    const plan=orderPlan(fresh,pooled.prob,Math.min(remaining,env.BUYER_MAX_POSITION_USDC,kelly*env.BUYER_PER_MARKET_BUDGET_USDC),this.o.feeBps);
    if (!plan || plan.edge<env.BUYER_EDGE_THRESHOLD) { await this.emit('skip',{reason:'insufficient_executable_edge'},symbol); return; }
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
    if (expiry-Date.now()<120000) { await this.emit('skip',{reason:'market_expired_or_expiry_unknown'},symbol); return; }
    if (!ledger.reserve('trade',symbol,symbol,plan.reserve)) { await this.emit('skip',{reason:'trade_reservation_denied'},symbol); return; }
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
    // Discovery is shared by the whole scan. One unavailable service must not
    // produce one request and one error for every Gemini instrument.
    let listings:ForecastListing[];
    try { listings=await this.listings(); }
    catch (e) { await this.emit('error',{operation:'discovery',status:'scan_paused',reason:e instanceof Error?e.message:'forecaster_unavailable'}); return; }
    const seen=new Set<string>();
    const contracts:GeminiContract[]=[];
    // Bounded pagination prevents an upstream pagination bug from creating an unbounded tick.
    for (let offset=0;offset<1000;offset+=100) {
      const page=await this.o.gemini.listEvents({status:['active'],limit:100,offset}).catch(async(e:unknown)=>{
        const http=e instanceof Error?/returned HTTP (\d{3})$/.exec(e.message):null;
        await this.emit('error',{operation:'market_catalog',status:'scan_paused',reason:http?`gemini_http_${http[1]}`:'gemini_market_data_unavailable'});
        return null;
      });
      if (!page) return;
      for (const event of page.data) {
        if (event.type!=='binary' || event.status!=='active' || event.resolvedAt) continue;
        for (const c of event.contracts) {
          const ttl=Date.parse(c.expiryDate ?? event.expiryDate ?? '')-Date.now();
          if (seen.has(c.instrumentSymbol) || c.status!=='active' || c.resolutionSide || c.resolvedAt || !Number.isFinite(ttl) || ttl<120000 || ttl>86400000 || (c.prices.bestAsk===null && c.prices.bestBid===null)) continue;
          seen.add(c.instrumentSymbol);
          contracts.push(c);
        }
      }
      if (!page.data.length || offset+100>=page.pagination.total) break;
    }
    const {env,wallet,program,programId,ledger}=this.o;
    if (!env.BUYER_DRY_RUN && wallet && program && programId && this.o.paymentScheme!=='exact') {
      const eligible=new Set(contracts.filter(c=>hasQuotableBook(c,this.o.feeBps)).map(c=>c.instrumentSymbol));
      const candidates=listings.filter(l=>eligible.has(l.instrumentSymbol) && !ledger.has('read',l.forecastPda));
      const recipients=new Set<string>();
      const hasBundle=candidates.some(l=>{ if(recipients.has(l.forecasterAuthority)) return true; recipients.add(l.forecasterAuthority); return false; });
      if (hasBundle) {
        try { await buyChannels({base:env.FORECASTER_URL,rpcUrl:env.SOLANA_RPC_URL,wallet,program,programId,ledger,minReputationBps:env.BUYER_MIN_FORECASTER_REPUTATION_BPS},candidates); }
        catch { await this.emit('error',{operation:'channel_discovery',status:'scan_paused',reason:'channel_service_unavailable'}); return; }
      }
    }
    for (const c of contracts) {
      try { await this.market(c,listings.filter(l=>l.instrumentSymbol===c.instrumentSymbol)); } catch { await this.emit('error',{operation:'market',status:'blocked',reason:'market_processing_failed'},c.instrumentSymbol); }
    }
  }
}
