import assert from 'node:assert/strict';
import { randomBytes,createHash } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import pg from 'pg';

async function http(base, path, status) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(4000) });
  assert.equal(response.status, status);
  const body = await response.text();
  if (path === '/health' || path === '/ready') {
    assert.deepEqual(JSON.parse(body), { status: status === 200 ? 'ok' : 'unavailable' });
  }
  return body;
}
async function eventually(action) {
  const deadline = Date.now() + 20000;
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) { if (attempt >= 30 || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
}
async function development() {
  const base = 'http://dev-web:5173';
  await eventually(() => http(base, '/ready', 200));
  const client = await http(base, '/@vite/client', 200);
  const token = /const wsToken = "([^"]+)"/.exec(client)?.[1];
  assert.ok(token, 'HMR token not found');
  const socket = new WebSocket(`ws://dev-web:5173/?token=${encodeURIComponent(token)}`, 'vite-hmr');
  const messages = [];
  socket.addEventListener('message', event => { messages.push(JSON.parse(event.data)); });
  const name = `mimir-hmr-${randomBytes(6).toString('hex')}.ts`;
  let created = false;
  try {
    await eventually(() => assert.ok(messages.some(message => message.type === 'connected')));
    await writeFile(`/hmr/${name}`, "export const proof='before'; if(import.meta.hot) import.meta.hot.accept();\n", { flag: 'wx' });
    created = true;
    assert.match(await http(base, `/src/${name}`, 200), /before/);
    await writeFile(`/hmr/${name}`, "export const proof='after'; if(import.meta.hot) import.meta.hot.accept();\n");
    await eventually(() => assert.ok(messages.some(message => message.type === 'update' && message.updates.some(update => update.path === `/src/${name}`))));
    assert.match(await http(base, `/src/${name}`, 200), /after/);
  } finally {
    socket.close();
    if (created) await unlink(`/hmr/${name}`);
  }
}

try {
  const mode = process.argv[2];
  if (mode === 'available') {
    await eventually(() => http('http://api:3000', '/ready', 200));
    await http('http://api:3000', '/health', 200);
    const indexHtml = await http('http://api:3000', '/', 200);
    assert.match(indexHtml, /Mimir Contabilidade/);
    const jsAsset = /src="(\/assets\/[^"]+\.js)"/.exec(indexHtml)?.[1];
    const cssAsset = /href="(\/assets\/[^"]+\.css)"/.exec(indexHtml)?.[1];
    assert.ok(jsAsset && cssAsset, 'SPA asset paths missing in index.html');
    const jsBundle = await http('http://api:3000', jsAsset, 200);
    await http('http://api:3000', cssAsset, 200);
    for (const route of ['/api/v1/session', '/api/v1/accounts', '/api/v1/transactions', '/api/v1/deliveries']) {
      assert.ok(jsBundle.includes(route), `SPA bundle missing ${route}`);
    }
  } else if (mode === 'unavailable') {
    await http('http://api:3000', '/health', 200);
    await eventually(() => http('http://api:3000', '/ready', 503));
  } else if (mode === 'persisted') {
    const url = new URL(process.env.MIGRATION_DATABASE_URL);
    url.username = 'mimir_runtime'; url.password = process.env.APP_ROLE_PASSWORD;
    const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
    await client.connect();
    try {
      const bytes=Buffer.from('%PDF-1.4\nSYNTHETIC I01\n'),hash=createHash('sha256').update(bytes).digest('hex');
      const result = await client.query('SELECT bytes,hash FROM mimir.documents WHERE hash=$1',[hash]);
      assert.equal(result.rows.length,2);
      for(const row of result.rows){assert.deepEqual(row.bytes,bytes);assert.equal(createHash('sha256').update(row.bytes).digest('hex'),row.hash);}
    } finally { await client.end(); }
  } else if (mode === 'dev') await development();
  else throw new Error('Invalid probe mode');
  console.log(`PASS probe=${mode}`);
} catch {
  console.error(`FAIL probe=${process.argv[2] ?? 'missing'}`);
  process.exitCode = 1;
}
