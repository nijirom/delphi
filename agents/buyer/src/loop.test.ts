import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { GeminiClient, commitment, marketHash, pdas, type AgentTelemetry, type DelphiProgram, type Env, type ForecastListing, type GeminiContract, type GeminiEvent } from '@delphi/shared';
import { Ledger } from './guardrails.js';
import { Buyer } from './loop.js';

function scenario(t:TestContext, refresh:(event:GeminiEvent)=>GeminiEvent|null = event=>event) {
  let now=Date.parse('2026-11-13T12:00:00Z');
  t.mock.method(Date,'now',()=>now);
  const expiry=now+3600000, symbol='GEMI-CONTRACT-UP', ticker='PARENT-EVENT';
  const contract:GeminiContract={id:'contract',label:'Up',ticker:'UP',instrumentSymbol:symbol,status:'active',resolutionSide:null,resolvedAt:null,expiryDate:null,prices:{buy:{yes:'0.8',no:'0.3'},sell:{yes:'0.7',no:'0.2'},bestBid:'0.7',bestAsk:'0.8',lastTradePrice:'0.75'},quantityMinimum:'1',quantityIncrement:'1',priceIncrement:'0.01',priceMinimum:'0.01'};
  const event:GeminiEvent={id:'event',title:'Event',ticker,category:'crypto',type:'binary',status:'active',resolvedAt:null,expiryDate:new Date(expiry).toISOString(),contracts:[contract]};
  const fresh:GeminiEvent={...event,contracts:[{...contract,prices:{...contract.prices,bestBid:'0.39',bestAsk:'0.4'}}]};
  const wallet=Keypair.fromSeed(new Uint8Array(32).fill(1)), authority=Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
  const programId=Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey, addresses=pdas(programId);
  const forecaster=addresses.forecaster(authority), forecast=addresses.forecast(forecaster,marketHash(symbol));
  const listing:ForecastListing={forecastPda:forecast.toBase58(),forecasterPda:forecaster.toBase58(),forecasterAuthority:authority.toBase58(),forecasterName:'Fixture',instrumentSymbol:symbol,pricePerReadUsdc:0.01,reputationBps:9000,scoredCount:10,postedAt:now,url:`http://localhost:4020/forecasts/${forecast.toBase58()}`};
  const salt=Buffer.alloc(32,4), digest=commitment(9000,salt);
  const program={
    fetchForecast:async()=>({forecaster,market:addresses.market(marketHash(symbol)),commitment:digest,pricePerRead:10000n,revealed:false,forfeited:false}),
    fetchForecaster:async()=>({authority,pricePerRead:10000n,reputationBps:9000}),
    fetchMarket:async()=>({resolved:false}),
  } as unknown as DelphiProgram;
  const ledger=new Ledger(':memory:',100000000,10000000,5000000);
  t.after(()=>ledger.close());
  assert.equal(ledger.reserve('read',listing.forecastPda,symbol,10000),true);
  ledger.saveRead(listing.forecastPda,{
    verified:{listing,url:listing.url,amount:10000,recipient:listing.forecasterAuthority,commitment:Array.from(digest)},
    value:{forecastPda:listing.forecastPda,instrumentSymbol:symbol,probBps:9000,salt:salt.toString('hex'),rationale:'Fixture',forecasterName:'Fixture'},
    header:Buffer.from(JSON.stringify({success:true,transaction:bs58.encode(new Uint8Array(64).fill(5))})).toString('base64'),
  });
  const env={BUYER_DRY_RUN:false,FORECASTER_URL:'http://localhost:4020',BUYER_MIN_FORECASTER_REPUTATION_BPS:5000,BUYER_MAX_READ_PRICE_USDC:1,BUYER_MAX_POSITION_USDC:5,BUYER_PER_MARKET_BUDGET_USDC:10,BUYER_EDGE_THRESHOLD:0.15,GEMINI_API_KEY:'fixture',GEMINI_API_SECRET:'fixture',GEMINI_API_BASE:'https://api.sandbox.gemini.com',BUYER_VOICE_APPROVE_ABOVE_USDC:100,BUYER_AUTO_APPROVE_BELOW_USDC:100} as Env;
  const gemini=new GeminiClient({publicBase:'http://localhost:4999',privateBase:env.GEMINI_API_BASE});
  // Every HTTP request is intercepted; cached receipts avoid even a simulated payment request.
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    if (url.origin==='http://localhost:4020' && url.pathname==='/forecasts') return Response.json([listing]);
    if (url.origin==='http://localhost:4999' && url.pathname==='/v1/prediction-markets/events') {
      const offset=Number(url.searchParams.get('offset'));
      const data=offset===0?Array.from({length:100},(_,i)=>({...event,ticker:`OTHER-${i}`,contracts:[]})):offset===100?[event]:[];
      return Response.json({data,pagination:{limit:100,offset,total:101}});
    }
    if (url.origin==='http://localhost:4999' && url.pathname===`/v1/prediction-markets/events/${ticker}`) {
      const result=refresh(fresh);
      return result?Response.json(result):new Response(null,{status:404});
    }
    throw new Error(`Unexpected network request: ${url.origin}${url.pathname}`);
  });
  const orders:Parameters<GeminiClient['placeOrder']>[0][]=[];
  const terms=t.mock.method(gemini,'termsStatus',async()=>({hasAcceptedLatest:true}));
  t.mock.method(gemini,'placeOrder',async(order:Parameters<GeminiClient['placeOrder']>[0])=>{
    orders.push(order);
    return {orderId:1,status:'filled' as const,symbol:order.symbol,side:order.side,outcome:order.outcome,quantity:order.quantity,filledQuantity:order.quantity,price:order.price,avgExecutionPrice:order.price};
  });
  const buyer=new Buyer({env,ledger,gemini,program,wallet,programId,allowLive:false,feeBps:0});
  const telemetry:{stage:AgentTelemetry['stage'];detail:Record<string,unknown>}[]=[];
  t.mock.method(buyer,'emit',async(stage:AgentTelemetry['stage'],detail:Record<string,unknown>)=>{telemetry.push({stage,detail});});
  t.mock.method(buyer,'reconcile',async()=>{});
  return {buyer,ledger,symbol,orders,telemetry,terms,expiry,setNow:(value:number)=>{now=value;}};
}

test('paid candidate beyond page one trades at exact-event quotes with inherited event expiry',async t=>{
  const s=scenario(t);
  await s.buyer.tick();
  assert.equal(s.orders.length,1);
  assert.equal(s.orders[0].symbol,s.symbol);
  assert.equal(s.orders[0].price,'0.4');
  assert.equal(s.orders[0].quantity,'6');
  assert.equal(s.orders[0].timeInForce,'immediate-or-cancel');
  assert.equal(s.ledger.has('trade',s.symbol),true);
  assert.equal(s.telemetry.at(-1)?.stage,'trade');
});

const rejected:{name:string;refresh:(event:GeminiEvent)=>GeminiEvent|null;reason:string}[]=[
  {name:'unknown event',refresh:()=>null,reason:'market_refresh_unavailable'},
  {name:'wrong parent',refresh:e=>({...e,ticker:'OTHER'}),reason:'market_not_active_binary'},
  {name:'inactive event',refresh:e=>({...e,status:'closed'}),reason:'market_not_active_binary'},
  {name:'categorical event',refresh:e=>({...e,type:'categorical'}),reason:'market_not_active_binary'},
  {name:'unmatched contract',refresh:e=>({...e,contracts:e.contracts.map(c=>({...c,instrumentSymbol:'GEMI-OTHER-UP'}))}),reason:'contract_unavailable'},
  {name:'inactive contract',refresh:e=>({...e,contracts:e.contracts.map(c=>({...c,status:'closed'}))}),reason:'contract_unavailable'},
  {name:'resolved contract',refresh:e=>({...e,contracts:e.contracts.map(c=>({...c,resolutionSide:'yes'}))}),reason:'contract_unavailable'},
  {name:'expired inherited expiry',refresh:e=>({...e,expiryDate:new Date(Date.now()-1).toISOString()}),reason:'market_expired_or_expiry_unknown'},
  {name:'expired contract overrides future parent expiry',refresh:e=>({...e,contracts:e.contracts.map(c=>({...c,expiryDate:new Date(Date.now()-1).toISOString()}))}),reason:'market_expired_or_expiry_unknown'},
  {name:'unknown expiry',refresh:e=>({...e,expiryDate:null}),reason:'market_expired_or_expiry_unknown'},
];
for (const row of rejected) test(`refresh rejects ${row.name} before authorization and reports a skip`,async t=>{
  const s=scenario(t,row.refresh);
  await s.buyer.tick();
  assert.equal(s.orders.length,0);
  assert.equal(s.ledger.has('trade',s.symbol),false);
  assert.equal(s.terms.mock.callCount(),0);
  assert.ok(s.telemetry.some(e=>e.stage==='aggregate'));
  assert.deepEqual(s.telemetry.at(-1),{stage:'skip',detail:{reason:row.reason}});
});

test('inherited expiry is rechecked after authorization without reserving or trading',async t=>{
  const s=scenario(t);
  s.terms.mock.mockImplementation(async()=>{s.setNow(s.expiry-119999);return {hasAcceptedLatest:true};});
  await s.buyer.tick();
  assert.ok(s.telemetry.some(e=>e.stage==='decide'));
  assert.equal(s.orders.length,0);
  assert.equal(s.ledger.has('trade',s.symbol),false);
  assert.deepEqual(s.telemetry.at(-1),{stage:'skip',detail:{reason:'market_expired_or_expiry_unknown'}});
});

test('dry run emits enriched skip telemetry once and throttles duplicate ticks for 10 minutes',async t=>{
  const s=scenario(t);
  s.buyer.o.env.BUYER_DRY_RUN=true;
  await s.buyer.tick();
  const first=s.telemetry.filter(e=>e.stage==='skip');
  assert.equal(first.length,1);
  assert.equal(first[0].detail.reason,'dry_run_no_payments_or_trades');
  assert.equal(first[0].detail.count,1);
  assert.equal(first[0].detail.topReputationBps,9000);
  assert.equal(first[0].detail.mid,0.75);
  await s.buyer.tick();
  assert.equal(s.telemetry.filter(e=>e.stage==='skip').length,1);
  s.setNow(Date.now()+600000);
  await s.buyer.tick();
  assert.equal(s.telemetry.filter(e=>e.stage==='skip').length,2);
});

test('a shared discovery outage pauses the scan once and recovers next tick',async t=>{
  const s=scenario(t);
  s.buyer.o.env.BUYER_DRY_RUN=true;
  const transport=globalThis.fetch;
  let unavailable=true,requests=0;
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    if (url.pathname==='/forecasts') {
      requests++;
      if (unavailable) return new Response(null,{status:503});
    }
    return transport(input,init);
  });
  await s.buyer.tick();
  assert.equal(requests,1);
  assert.deepEqual(s.telemetry.filter(e=>e.stage==='error'),[
    {stage:'error',detail:{operation:'discovery',status:'scan_paused',reason:'forecaster_http_503'}},
  ]);
  assert.equal(s.orders.length,0);
  unavailable=false;
  await s.buyer.tick();
  assert.equal(requests,2);
  assert.ok(s.telemetry.some(e=>e.stage==='skip' && e.detail.reason==='dry_run_no_payments_or_trades'));
  assert.equal(s.telemetry.filter(e=>e.stage==='error').length,1);
});

test('catalog failures retain an actionable HTTP reason without exposing response bodies',async t=>{
  const s=scenario(t);
  t.mock.method(s.buyer.o.gemini,'listEvents',async()=>{throw new Error('Gemini GET /v1/prediction-markets/events returned HTTP 429');});
  await s.buyer.tick();
  assert.deepEqual(s.telemetry.filter(e=>e.stage==='error'),[
    {stage:'error',detail:{operation:'market_catalog',status:'scan_paused',reason:'gemini_http_429'}},
  ]);
  assert.equal(s.orders.length,0);
});
