import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../../apps/api/dist/config.js';
import { safeInteger, civilDate } from '../../apps/api/dist/adapters/postgres.js';

test('BIGINT rejects unsafe values and preserves exact safe bounds', () => {
  for (const value of ['9007199254740991', '-9007199254740991', '99999999999', '0']) assert.equal(String(safeInteger(value)), value);
  for (const value of ['9007199254740992', '-9007199254740992', '1e3', '1.2', '']) assert.throws(() => safeInteger(value));
});
test('civil DATE preserves leap days and rejects impossible dates', () => {
  for (const value of ['1900-01-01', '2024-02-29', '9999-12-31']) assert.equal(civilDate(value), value);
  for (const value of ['2023-02-29', '2024-02-30', '2026-13-01', 'infinity', '1899-12-31']) assert.throws(() => civilDate(value));
});
test('runtime rejects administrative configuration without echoing values', () => {
  const env = { APP_DATABASE_URL: 'postgresql://mimir_runtime:synthetic@localhost/mimir' };
  assert.equal(readConfig(env).host, '127.0.0.1');
  for (const key of ['MIGRATION_DATABASE_URL', 'PROVISION_DATABASE_URL', 'POSTGRES_PASSWORD', 'MIGRATOR_PASSWORD', 'APP_ROLE_PASSWORD']) {
    assert.throws(() => readConfig({ ...env, [key]: 'must-not-appear' }), error => !error.message.includes('must-not-appear'));
  }
  assert.throws(() => readConfig({ APP_DATABASE_URL: 'postgresql://postgres:synthetic@localhost/mimir' }));
  assert.throws(() => readConfig({ ...env, PORT: 'NaN' }));
});
