import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const defaults = {
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  SOLANA_NETWORK_CAIP2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  DELPHI_PROGRAM_ID: '', DELPHI_ORACLE_KEYPAIR: './keys/oracle.json',
  FORECASTER_KEYPAIR: './keys/forecaster.json', BUYER_KEYPAIR: './keys/buyer.json',
  X402_FACILITATOR_URL: 'https://x402.org/facilitator',
  FORECASTER_PORT: 4020, FORECASTER_URL: 'http://localhost:4020',
  INDEXER_PORT: 4030, INDEXER_URL: 'http://localhost:4030', INDEXER_DB: './data/indexer.sqlite',
  STREAMS_WEBHOOK_SECRET: '', GEMINI_API_BASE: 'https://api.sandbox.gemini.com',
  GEMINI_PUBLIC_API_BASE: 'https://api.gemini.com', GEMINI_API_KEY: '', GEMINI_API_SECRET: '',
  ELEVENLABS_API_KEY: '', ELEVENLABS_AGENT_ID: '', ELEVENLABS_PHONE_NUMBER_ID: '', APPROVER_PHONE_NUMBER: '',
  BUYER_DAILY_BUDGET_USDC: 5, BUYER_PER_MARKET_BUDGET_USDC: 0.5, BUYER_MAX_READ_PRICE_USDC: 0.05,
  BUYER_MIN_FORECASTER_REPUTATION_BPS: 4000, BUYER_EDGE_THRESHOLD: 0.06, BUYER_MAX_POSITION_USDC: 2,
  BUYER_AUTO_APPROVE_BELOW_USDC: 0.5, BUYER_VOICE_APPROVE_ABOVE_USDC: 1,
  BUYER_DRY_RUN: true, HOST: '127.0.0.1', RESOLVER_PORT: 4040,
  BUYER_DB: './data/buyer.sqlite', FORECASTER_DB: './data/forecaster.sqlite', INDEXER_SOURCE: 'streams',
};
export type Env = typeof defaults & { [key: string]: string | number | boolean | undefined };
export function loadEnv(): Env {
  dotenv.config({ path: resolve(REPO_ROOT, '.env') });
  const result: Record<string, string | number | boolean | undefined> = { ...process.env };
  for (const [key, fallback] of Object.entries(defaults)) {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === '') { result[key] = fallback; continue; }
    if (typeof fallback === 'boolean') {
      if (!['true', 'false'].includes(raw)) throw new Error(`${key} must be true or false`);
      result[key] = raw === 'true';
    } else if (typeof fallback === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a finite nonnegative number`);
      if (key.endsWith('_PORT') && (!Number.isInteger(value) || value < 1 || value > 65535)) throw new Error(`${key} must be a valid port`);
      result[key] = value;
    } else result[key] = raw;
  }
  const env = result as Env;
  if (env.BUYER_MIN_FORECASTER_REPUTATION_BPS > 10000 || env.BUYER_EDGE_THRESHOLD > 1) throw new Error('Buyer probability/reputation limit out of range');
  if (env.BUYER_AUTO_APPROVE_BELOW_USDC > env.BUYER_VOICE_APPROVE_ABOVE_USDC) throw new Error('Buyer approval thresholds are reversed');
  if (!['streams', 'rpc'].includes(env.INDEXER_SOURCE)) throw new Error('INDEXER_SOURCE must be streams or rpc');
  return env;
}
