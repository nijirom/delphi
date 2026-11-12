import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)) });
await server.listen();
server.printUrls();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void server.close().then(() => { process.exitCode = 0; });
  });
}
