export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const sensitive = /secret|password|token|authorization|cookie|keypair|private.?key|api.?key|salt|payment.signature|phone/i;
function clean(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'bigint') return value.toString();
  // Error messages and arbitrary strings may contain credentials; do not emit them.
  if (value instanceof Error) return { error: value.name };
  if (typeof value === 'string') {
    let text = value;
    for (const [key, secret] of Object.entries(process.env)) if (sensitive.test(key) && secret) text = text.split(secret).join('[REDACTED]');
    return text.replace(/https?:\/\/[^\s]+/g, '[URL]').replace(/Bearer\s+\S+/gi, '[REDACTED]');
  }
  if (value && typeof value === 'object') {
    if (ArrayBuffer.isView(value)) return '[BINARY]';
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(v => clean(v, seen));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sensitive.test(k) ? '[REDACTED]' : clean(v, seen)]));
  }
  return value;
}
export function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: clean(msg), ...(fields ? { fields: clean(fields) } : {}) });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}
