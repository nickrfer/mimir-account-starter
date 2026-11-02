import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { arch, cpus, totalmem, platform, release } from 'node:os';
import pg from 'pg';
import { createOwner } from '../../admin/owners.mjs';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function runtimeUrl() {
  const url = new URL(process.env.MIGRATION_DATABASE_URL);
  url.username = 'mimir_runtime'; url.password = process.env.APP_ROLE_PASSWORD;
  return url.toString();
}

export async function adminClient() {
  const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  return client;
}

export async function startApi(port = 3100) {
  const origin = `http://127.0.0.1:${port}`;
  const env = { APP_DATABASE_URL: runtimeUrl(), HOST: '127.0.0.1', PORT: String(port), APP_ORIGINS: origin, ALLOW_LOCAL_HTTP: 'true', PATH: process.env.PATH };
  const child = spawn(process.execPath, ['apps/api/dist/index.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin + '/ready')).status === 200) return { base: origin, origin, child, stop: () => stopChild(child) }; } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error('API encerrou ao iniciar: ' + stderr);
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error('API não ficou pronta: ' + stderr);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

export async function identity(api, label) {
  const email = `${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex');
  const created = await createOwner({ email, password, displayName: label, companyName: label });
  const login = async () => {
    const r = await fetch(api.base + '/api/v1/session', { method: 'POST', headers: { Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (r.status !== 200) throw new Error(`login ${label}: ${r.status}`);
    return { token: r.headers.get('set-cookie').match(/^mimir_session=([a-f0-9]{64});/)[1], csrf: (await r.json()).csrfToken };
  };
  return { label, workspaceId: created.workspaceId, userId: created.userId, login };
}

export function client(api, session) {
  const headers = (extra = {}) => ({ Origin: api.origin, ...(session ? { Cookie: `mimir_session=${session.token}`, 'X-CSRF-Token': session.csrf } : {}), ...extra });
  const request = async (method, path, body, extra = {}) => {
    const init = { method, headers: headers(extra) };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(api.base + '/api/v1' + path, init);
    const raw = Buffer.from(await r.arrayBuffer());
    let json = null; try { json = JSON.parse(raw.toString('utf8')); } catch { /* binary */ }
    return { status: r.status, json, raw, headers: r.headers };
  };
  return { request, headers };
}

export async function environment(admin) {
  const pgVersion = (await admin.query('SHOW server_version')).rows[0].server_version;
  return {
    scenario: process.env.EVAL_SCENARIO, project: process.env.EVAL_PROJECT, commit: process.env.EVAL_COMMIT, tag: 'poc-v1.0.0',
    productEqualToTag: process.env.EVAL_PRODUCT_CHANGED === 'False', docker: process.env.EVAL_DOCKER, node: process.version, postgres: pgVersion,
    container: { platform: platform(), release: release(), arch: arch(), cpus: cpus().length, cpuModel: cpus()[0]?.model ?? null, memoryBytes: totalmem() },
    startedAt: new Date().toISOString(),
  };
}

export async function writeResult(result, markdown) {
  await writeFile('/out/result.json', JSON.stringify(result, null, 2) + '\n');
  if (markdown) await writeFile('/out/result.md', markdown);
}
