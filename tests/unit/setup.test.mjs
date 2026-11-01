import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { setup } from '../../tools/admin/setup.mjs';

test('container setup writes host-relative configuration and independent random credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mimir-setup-'));
  await setup(dir, '.local/synthetic-test');
  const common = parseEnv(await readFile(join(dir, '.env'), 'utf8'));
  assert.equal(common.MIMIR_CONFIG_DIR, '.local/synthetic-test');
  const admin = parseEnv(await readFile(join(dir, '.env.admin'), 'utf8'));
  const runtime = parseEnv(await readFile(join(dir, '.env.runtime'), 'utf8'));
  assert.deepEqual(Object.keys(runtime).sort(), ['APP_DATABASE_URL', 'HOST', 'PORT']);
  const passwords = [admin.MIGRATOR_PASSWORD, admin.APP_ROLE_PASSWORD, new URL(admin.PROVISION_DATABASE_URL).password];
  assert.ok(passwords.every(value => /^[a-f0-9]{64}$/.test(value)));
  assert.equal(new Set(passwords).size, 3);
  assert.ok(passwords.every(value => !Object.values(common).includes(value)));
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, '.env.admin'))).mode & 0o777, 0o600);
});

test('setup refuses existing configuration without modifying any credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mimir-setup-existing-'));
  await writeFile(join(dir, '.env.admin'), 'preserve-existing-value');
  await assert.rejects(setup(dir, '.'), /já existe/);
  assert.equal(await readFile(join(dir, '.env.admin'), 'utf8'), 'preserve-existing-value');
  await assert.rejects(readFile(join(dir, '.env')),{code:'ENOENT'});
});
