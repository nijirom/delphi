import { createPublicKey, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

export const PUBLICATION_PATH = '/publications';
export const PUBLICATION_MAX_BYTES = 16384;
export const PUBLICATION_TTL_SECONDS = 300;
export type PublicationPayload = {
  version: 1; audience: string; programId: string; genesisHash: string; authority: string;
  forecastPda: string; eventTicker: string; instrumentSymbol: string; probBps: number;
  salt: string; rationale: string; nonce: string; issuedAt: number; expiresAt: number;
};
export type PublicationEnvelope = { payload: PublicationPayload; signature: string };
export class PublicationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const fields: (keyof PublicationPayload)[] = ['version', 'audience', 'programId', 'genesisHash', 'authority', 'forecastPda', 'eventTicker', 'instrumentSymbol', 'probBps', 'salt', 'rationale', 'nonce', 'issuedAt', 'expiresAt'];
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max; }
export function publicationAudience(url: string): string {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) throw new Error('Publishing requires HTTPS or loopback HTTP');
  return parsed.toString().replace(/\/$/, '');
}
/** UTF-8 domain prefix followed by fixed-order JSON; sign these bytes with the Solana wallet's Ed25519 key. */
export function publicationMessage(payload: PublicationPayload): Buffer {
  return Buffer.from(`Delphi forecast publication v1\nPOST ${PUBLICATION_PATH}\n${JSON.stringify(Object.fromEntries(fields.map(key => [key, payload[key]])))}`, 'utf8');
}
export function authenticatePublication(body: unknown, expected: { audience: string; programId: string; genesisHash: string }, now = Math.floor(Date.now() / 1000)): PublicationPayload {
  if (!object(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'payload') || !Object.hasOwn(body, 'signature') || !object(body.payload)) throw new PublicationError(400, 'Invalid publication schema');
  const p = body.payload;
  if (Object.keys(p).length !== fields.length || !fields.every(key => Object.hasOwn(p, key))) throw new PublicationError(400, 'Invalid publication schema');
  if (p.version !== 1 || p.audience !== expected.audience || p.programId !== expected.programId || p.genesisHash !== expected.genesisHash) throw new PublicationError(400, 'Publication domain mismatch');
  if (!text(p.authority, 44) || !text(p.forecastPda, 44) || !text(p.eventTicker, 128) || !/^[A-Za-z0-9_-]+$/.test(p.eventTicker) || !text(p.instrumentSymbol, 64) || !/^GEMI-[A-Za-z0-9_-]+$/.test(p.instrumentSymbol) || !Number.isInteger(p.probBps) || Number(p.probBps) < 0 || Number(p.probBps) > 10000 || !text(p.salt, 64) || !/^[a-f0-9]{64}$/.test(p.salt) || !text(p.rationale, 4096) || !text(p.nonce, 64) || !/^[a-f0-9]{64}$/.test(p.nonce)) throw new PublicationError(400, 'Invalid publication fields');
  if (!Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) || Number(p.issuedAt) > now + 30 || Number(p.expiresAt) <= now || Number(p.expiresAt) <= Number(p.issuedAt) || Number(p.expiresAt) - Number(p.issuedAt) > PUBLICATION_TTL_SECONDS || now - Number(p.issuedAt) > PUBLICATION_TTL_SECONDS) throw new PublicationError(401, 'Publication signature expired or not yet valid');
  if (!text(body.signature, 88) || !/^[A-Za-z0-9+/]{86}==$/.test(body.signature)) throw new PublicationError(401, 'Invalid wallet signature');
  const payload = p as PublicationPayload;
  try {
    const authority = new PublicKey(payload.authority);
    if (authority.toBase58() !== payload.authority || new PublicKey(payload.forecastPda).toBase58() !== payload.forecastPda) throw new Error('Noncanonical address');
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), authority.toBuffer()]), format: 'der', type: 'spki' });
    if (!verify(null, publicationMessage(payload), key, Buffer.from(body.signature, 'base64'))) throw new Error('Bad signature');
  } catch { throw new PublicationError(401, 'Invalid wallet signature'); }
  return payload;
}
