import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { PostgresExecutor } from '../../../apps/api/dist/adapters/postgres-executor.js';
import { DeliveryExecutor } from '../../../apps/api/dist/executor/runner.js';
import { runtimeUrl, sleep } from '../lib/harness.mjs';

const SIGNALS = '/signals';
const scope = new Set();
const port = new PostgresExecutor(runtimeUrl(), scope);
const paused = new Set();

async function current() {
  try { return JSON.parse(await readFile(`${SIGNALS}/run.json`, 'utf8')); } catch { return null; }
}
async function refreshScope() {
  try { for (const id of JSON.parse(await readFile(`${SIGNALS}/workspaces.json`, 'utf8'))) scope.add(id); } catch { /* none yet */ }
}

async function gate(point) {
  const run = await current();
  if (!run || run.point !== point || paused.has(run.index) || !existsSync(`${SIGNALS}/armed-${run.index}`) || existsSync(`${SIGNALS}/paused-${run.index}`)) return;
  paused.add(run.index);
  await writeFile(`${SIGNALS}/paused-${run.index}`, point);
  while (!existsSync(`${SIGNALS}/resume-${run.index}`)) await sleep(50);
}

const instrumented = {
  claimNextOperation: async holder => { await refreshScope(); await gate('P1'); return port.claimNextOperation(holder); },
  renewLease: claim => port.renewLease(claim),
  readSnapshot: async claim => { await gate('P2'); return port.readSnapshot(claim); },
  readCapturedDocument: async (claim, id) => { await gate('P3'); await gate('P5'); return port.readCapturedDocument(claim, id); },
  publishPackage: async (claim, published) => { await gate('P4'); return port.publishPackage(claim, published); },
  handleAttemptFailure: (claim, code) => port.handleAttemptFailure(claim, code),
  close: () => port.close(),
};

await refreshScope();
const executor = new DeliveryExecutor(instrumented, { workRoot: '/tmp/mimir-c02-work' });
await executor.start();
await writeFile(`${SIGNALS}/executor-${process.pid}-${Date.now()}`, 'started');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await executor.stop(); await port.close(); process.exit(0); });
