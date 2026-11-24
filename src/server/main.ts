import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { SecretBox } from './secrets.ts';
import { Store } from './store.ts';

const home = process.env.POLYPHONY_HOME ?? join(homedir(), '.polyphony');
const port = Number(process.env.PORT ?? 4317);
mkdirSync(home, { recursive: true });

const store = new Store(join(home, 'polyphony.db'));
const interrupted = store.failInterruptedRuns();
const webDir = fileURLToPath(new URL('../web', import.meta.url));
const app = await buildApp({
  store,
  secrets: SecretBox.fromHome(home),
  webDir,
  logger: false,
  workspaceRoot: join(home, 'workspaces'),
});

await app.listen({ host: '127.0.0.1', port });
console.log(`\n  Polyphony is running at http://127.0.0.1:${port}`);
console.log(`  Data: ${home}`);
if (interrupted > 0)
  console.log(`  ${interrupted} run(s) interrupted by the last shutdown were marked failed.`);
console.log('');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    store.close();
    process.exit(0);
  });
}
