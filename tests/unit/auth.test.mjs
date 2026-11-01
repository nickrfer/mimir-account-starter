import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginLimiter } from '../../apps/api/dist/auth/limiter.js';
import { readConfig } from '../../apps/api/dist/config.js';

test('Argon2id policy salts hashes and verifies exact Unicode passwords', async () => {
  const passwords = await import('../../apps/api/dist/auth/passwords.js').catch(() => null);
  assert.ok(passwords, 'I02 password policy missing');
  const password = 'synthetic senha longa á '.repeat(2);
  const first = await passwords.hashPassword(password);
  const second = await passwords.hashPassword(password);
  assert.match(first, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.notEqual(first, second);
  assert.equal(await passwords.verifyPassword(first, password), true);
  assert.equal(await passwords.verifyPassword(first, password.trim()), false);
  assert.equal(await passwords.verifyPassword('$argon2id$invalid', password), false);
});

test('login limiter reserves concurrent attempts, bounds work and expires after 15 minutes',()=>{
  let now=0;const limiter=new LoginLimiter(()=>now);
  const first=limiter.reserve('a@example.invalid','127.0.0.1');
  const second=limiter.reserve('b@example.invalid','127.0.0.1');
  assert.throws(()=>limiter.reserve('c@example.invalid','127.0.0.1'),error=>error.status===429&&error.retryAfter===1);
  first(true);second(true);
  for(let i=0;i<4;i++)limiter.reserve('a@example.invalid','127.0.0.1')(true);
  assert.throws(()=>limiter.reserve('a@example.invalid','127.0.0.1'),error=>error.status===429&&error.retryAfter===900);
  limiter.reserve('a@example.invalid','192.0.2.1')(false);
  now=900000;limiter.reserve('a@example.invalid','127.0.0.1')(false);
});

test('HTTP cookie exception is explicit and restricted to local Origin',()=>{
  const env={APP_DATABASE_URL:'postgresql://mimir_runtime:synthetic@localhost/mimir'};
  assert.equal(readConfig(env).allowLocalHttp,false);
  for(const value of ['http://example.com','https://example.com/path','https://name:secret@example.com','*','null']) {
    assert.throws(()=>readConfig({...env,ALLOW_LOCAL_HTTP:'true',APP_ORIGINS:value}));
  }
  assert.throws(()=>readConfig({...env,APP_ORIGINS:'http://localhost:3000'}));
  assert.equal(readConfig({...env,ALLOW_LOCAL_HTTP:'true',APP_ORIGINS:'http://localhost:3000'}).origins.has('http://localhost:3000'),true);
});

test('infrastructure abort neither consumes failures nor clears previous failures',()=>{
  const limiter=new LoginLimiter(()=>0);
  for(let i=0;i<4;i++)limiter.reserve('a@example.invalid','127.0.0.1')(true);
  limiter.reserve('a@example.invalid','127.0.0.1')(null);
  limiter.reserve('a@example.invalid','127.0.0.1')(true);
  assert.throws(()=>limiter.reserve('a@example.invalid','127.0.0.1'),error=>error.status===429);
  const clean=new LoginLimiter(()=>0);
  for(let i=0;i<6;i++)clean.reserve('a@example.invalid','127.0.0.1')(null);
  clean.reserve('a@example.invalid','127.0.0.1')(false);
});

test('login normalization rejects extra fields without altering passwords', async () => {
  const input = await import('../../apps/api/dist/auth/input.js').catch(() => null);
  assert.ok(input, 'I02 input validation missing');
  assert.deepEqual(input.loginInput({email:'  TEST@example.invalid ',password:' x '}),{email:'test@example.invalid',password:' x '});
  for (const value of [null,[],{email:'bad',password:'x'}, {email:'a@example.invalid',password:''},
    {email:'a@example.invalid',password:'x',workspaceId:'foreign'}, {email:'a@example.invalid',password:'x'.repeat(1025)}]) {
    assert.throws(() => input.loginInput(value));
  }
});
