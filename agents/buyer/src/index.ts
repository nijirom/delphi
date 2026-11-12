import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { loadEnv, REPO_ROOT, GeminiClient, DelphiProgram, connection, loadKeypair, log } from '@delphi/shared';
import { DEVNET, DEVNET_USDC, Ledger, units } from './guardrails.js';
import { Buyer } from './loop.js';

async function main():Promise<void> {
  const env=loadEnv();
  if (env.SOLANA_NETWORK_CAIP2!==DEVNET || env.USDC_MINT!==DEVNET_USDC) throw new Error('Buyer supports devnet USDC only');
  const limits=[env.BUYER_DAILY_BUDGET_USDC,env.BUYER_PER_MARKET_BUDGET_USDC,env.BUYER_MAX_READ_PRICE_USDC,env.BUYER_MAX_POSITION_USDC];
  if (limits.some(x=>!Number.isFinite(x)||x<0) || !Number.isFinite(env.BUYER_EDGE_THRESHOLD) || env.BUYER_EDGE_THRESHOLD<0 || env.BUYER_EDGE_THRESHOLD>=1 || !Number.isFinite(env.BUYER_AUTO_APPROVE_BELOW_USDC) || env.BUYER_AUTO_APPROVE_BELOW_USDC<0 || !Number.isFinite(env.BUYER_VOICE_APPROVE_ABOVE_USDC) || env.BUYER_VOICE_APPROVE_ABOVE_USDC<env.BUYER_AUTO_APPROVE_BELOW_USDC) throw new Error('Invalid buyer limits');
  const feeBps=Number(process.env.BUYER_FEE_BUFFER_BPS ?? '200');
  if (!Number.isInteger(feeBps)||feeBps<0||feeBps>10000) throw new Error('Invalid fee buffer');
  process.umask(0o077);
  const dir=resolve(REPO_ROOT,'data'); mkdirSync(dir,{recursive:true,mode:0o700});
  const dbPath=resolve(REPO_ROOT,env.BUYER_DB);
  const ledger=new Ledger(dbPath,units(env.BUYER_DAILY_BUDGET_USDC),units(env.BUYER_PER_MARKET_BUDGET_USDC),units(env.BUYER_MAX_POSITION_USDC)); chmodSync(dbPath,0o600);
  const gemini=new GeminiClient({publicBase:env.GEMINI_PUBLIC_API_BASE,privateBase:env.GEMINI_API_BASE || 'https://api.sandbox.gemini.com',apiKey:env.GEMINI_API_KEY,apiSecret:env.GEMINI_API_SECRET});
  let integration:Pick<ConstructorParameters<typeof Buyer>[0],'wallet'|'program'|'programId'>={};
  if (!env.BUYER_DRY_RUN) {
    if (!env.BUYER_KEYPAIR || !env.DELPHI_PROGRAM_ID) throw new Error('Paid mode requires buyer wallet and program ID');
    if (await connection(env).getGenesisHash() !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('Paid buyer requires verified Solana devnet RPC');
    const wallet=loadKeypair(env.BUYER_KEYPAIR),programId=new PublicKey(env.DELPHI_PROGRAM_ID);
    integration={wallet,programId,program:new DelphiProgram(connection(env),wallet,programId,resolve(REPO_ROOT,'packages/shared/idl/delphi.json'))};
  }
  const buyer=new Buyer({env,ledger,gemini,...integration,feeBps,allowLive:process.env.BUYER_ALLOW_LIVE_TRADING==='true'});
  let stopped=false;
  const abort=new AbortController();
  const stop=()=>{stopped=true;abort.abort();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const {setTimeout:sleep}=await import('node:timers/promises');
  try {
    while (!stopped) {
      try { await buyer.tick(); } catch { await buyer.emit('error',{operation:'tick',status:'blocked'}); }
      if (!stopped) await sleep(30000,undefined,{signal:abort.signal}).catch(()=>undefined);
    }
  } finally { ledger.close(); }
}
main().catch(()=>{log('error','Buyer startup failed; check configuration and integration availability');process.exitCode=1;});
