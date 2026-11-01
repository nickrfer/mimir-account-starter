import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPackage } from '../packaging/build.js';
import { PackagingError } from '../packaging/zip.js';
import { LeaseLostError } from '../ports/executor.js';
import type { ExecutorPort, OperationClaim } from '../ports/executor.js';

export interface ExecutorOptions {
  pollMs?: number; renewMs?: number; workRoot?: string; holder?: string; build?: typeof buildPackage;
  log?: (event: { operationId: string; attempt: number; outcome: string }) => void;
}

const PUBLIC_CODES = new Set(['PACKAGE_TOO_LARGE', 'MANIFEST_TOO_LARGE', 'DOCUMENT_INTEGRITY', 'SNAPSHOT_INVALID']);
const publicCode = (error: unknown) => (error instanceof PackagingError && PUBLIC_CODES.has(error.code) ? error.code : 'PACKAGE_GENERATION_FAILED');

// One executor per API process, one operation at a time. Every database write is fenced by the claim token.
export class DeliveryExecutor {
  private readonly pollMs: number; private readonly renewMs: number; private readonly workRoot: string; private readonly holder: string;
  private readonly build: typeof buildPackage; private readonly log: NonNullable<ExecutorOptions['log']>;
  private timer: NodeJS.Timeout | null = null; private running: Promise<void> | null = null; private stopped = false;

  constructor(private readonly port: ExecutorPort, options: ExecutorOptions = {}) {
    this.pollMs = options.pollMs ?? 2000; this.renewMs = options.renewMs ?? 5000;
    this.workRoot = options.workRoot ?? join(tmpdir(), 'mimir-delivery'); this.holder = options.holder ?? `executor-${randomUUID()}`;
    this.build = options.build ?? buildPackage; this.log = options.log ?? (event => console.info(JSON.stringify({ executor: event })));
  }

  async start(): Promise<void> {
    await rm(this.workRoot, { recursive: true, force: true });
    await mkdir(this.workRoot, { recursive: true, mode: 0o700 });
    const schedule = () => { if (!this.stopped) this.timer = setTimeout(() => { void this.tick().finally(schedule); }, this.pollMs); };
    schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const claim = await this.port.claimNextOperation(this.holder);
        if (claim) await this.process(claim);
      } catch { /* the next poll retries; the lease protects half-finished work */ }
      finally { this.running = null; }
    })();
    return this.running;
  }

  private async process(claim: OperationClaim): Promise<void> {
    const controller = new AbortController(), workDir = join(this.workRoot, `${claim.operationId}-${claim.token}`);
    const renew = setInterval(() => {
      this.port.renewLease(claim).then(ok => { if (!ok) controller.abort(); }).catch(() => undefined);
    }, this.renewMs);
    let outcome = 'LOST';
    try {
      const payload = await this.port.readSnapshot(claim);
      const built = await this.build(payload, id => this.port.readCapturedDocument(claim, id), workDir, controller.signal);
      controller.signal.throwIfAborted();
      const zip = await readFile(built.zipPath);
      const published = await this.port.publishPackage(claim, { zip, zipHash: built.zipHash, manifest: built.manifest, manifestHash: built.manifestHash });
      outcome = published ? 'PRONTA' : 'LOST';
    } catch (error) {
      if (controller.signal.aborted || error instanceof LeaseLostError) outcome = 'LOST';
      else outcome = await this.port.handleAttemptFailure(claim, publicCode(error)).catch(() => 'LOST');
    } finally {
      clearInterval(renew);
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      try { this.log({ operationId: claim.operationId, attempt: claim.attempt, outcome }); } catch { /* logging never changes the outcome */ }
    }
  }
}
