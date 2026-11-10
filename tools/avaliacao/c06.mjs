import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { client, environment, adminClient, identity, sleep, writeResult } from './lib/harness.mjs';

const SIGNALS = '/signals', MONTH = '2026-10', DOC_BYTES = 524288, WARMUPS = 3, SAMPLES = 30, LIMIT_MS = 10000, RSS_LIMIT = 512 * 1024 * 1024;
const api = { base: 'http://api:3000', origin: 'http://127.0.0.1:3000' };
const invalidRuns = JSON.parse(await readFile('tools/avaliacao/execucoes-invalidas.json', 'utf8')).C06 ?? [];
const admin = await adminClient(), env = await environment(admin);

async function hostStep(name) {
  await rm(`${SIGNALS}/${name}.done`, { force: true });
  await writeFile(`${SIGNALS}/${name}.request`, 'go');
  for (let i = 0; i < 1800 && !existsSync(`${SIGNALS}/${name}.done`); i++) await sleep(100);
  if (!existsSync(`${SIGNALS}/${name}.done`)) throw new Error(`host não concluiu ${name}`);
  const text = await readFile(`${SIGNALS}/${name}.done`, 'utf8');
  if (name === 'read-hwm' && !(Number(text) > 20 * 1048576)) throw new Error(`VmHWM implausível para o processo Node da API: ${text.trim()}`);
  for (let i = 0; i < 300; i++) { try { if ((await fetch(api.base + '/ready')).status === 200) break; } catch { /* restarting */ } await sleep(100); }
  return text.trim();
}

async function workspace(label, transactions, documents) {
  const A = await identity(api, label), a = client(api, await A.login());
  const rev = async () => Number((await admin.query('SELECT revision::text n FROM mimir.workspaces WHERE id=$1', [A.workspaceId])).rows[0].n);
  const ok = (r, code) => { if (r.status !== code) throw new Error(`setup ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  const pj = ok(await a.request('POST', '/accounts', { name: 'Conta PJ', accountType: 'PJ', expectedRevision: await rev() }), 201).account.id;
  const pf = ok(await a.request('POST', '/accounts', { name: 'Conta PF', accountType: 'PF', expectedRevision: await rev() }), 201).account.id;
  const ids = [];
  for (let i = 0; i < transactions; i++) {
    const income = i % 5 === 0, personal = i % 7 === 0 && !income;
    ids.push(ok(await a.request('POST', '/transactions', { accountId: personal ? pf : pj, occurredOn: `${MONTH}-${String(1 + (i % 28)).padStart(2, '0')}`,
      direction: income ? 'ENTRADA' : 'SAIDA', amountCents: 1000 + i * 37, description: `Movimentação sintética ${i} - ação ç`, category: ['SERVICOS', 'INFRA', 'TARIFAS', 'IMPOSTOS'][i % 4],
      classification: income ? 'RECEITA' : 'DESPESA', isPfBusinessExpense: personal, explanation: '', expectedRevision: await rev() }), 201).transaction.transactionId);
  }
  for (let i = 0; i < documents; i++) {
    const head = Buffer.from(`%PDF-1.7\nSynthetic C06 ${label} ${i}\n`), tail = Buffer.from('\n%%EOF\n');
    const bytes = Buffer.concat([head, Buffer.alloc(DOC_BYTES - head.length - tail.length, 0x20 + (i % 90)), tail]);
    const f = new FormData(); f.append('file', new Blob([bytes], { type: 'application/pdf' }), `doc-${i}.pdf`); f.append('expectedRevision', String(await rev()));
    ok(await a.request('POST', `/transactions/${ids[i % ids.length]}/documents`, f), 201);
  }
  return { A, a, rev };
}

async function generate({ a, rev }, n) {
  const r = await a.request('POST', '/deliveries', { periodMonth: MONTH, expectedRevision: await rev(), rectificationReason: n === 1 ? '' : `Amostra de desempenho ${n}` },
    { 'Idempotency-Key': `c06-${n}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  if (r.status !== 202) throw new Error(`captura ${r.status} ${JSON.stringify(r.json)}`);
  const op = r.json; let status = null;
  for (let i = 0; i < 1800; i++) { status = (await a.request('GET', `/operations/${op.id}`)).json?.status; if (status === 'PRONTA' || status === 'FALHA') break; await sleep(100); }
  const t = (await admin.query(`SELECT EXTRACT(EPOCH FROM (p.created_at - o.created_at)) * 1000 AS ms, p.zip_size FROM mimir.delivery_operations o
    LEFT JOIN mimir.delivery_packages p ON p.operation_id=o.id WHERE o.id=$1`, [op.id])).rows[0];
  let downloaded = null;
  if (status === 'PRONTA') { const d = await a.request('GET', `/deliveries/${op.snapshotId}/package`); downloaded = d.status === 200 ? d.raw.length : null; }
  return { status, ms: t.ms === null ? null : Math.round(Number(t.ms)), zipSize: t.zip_size === null ? null : Number(t.zip_size), downloadedBytes: downloaded };
}

try {
  console.log('EVAL preparando massa de referência: 200 movimentações, 50 anexos de 512 KiB');
  const ref = await workspace('Synthetic C06 referência', 200, 50);
  const warmups = [];
  for (let i = 1; i <= WARMUPS; i++) { warmups.push(await generate(ref, i)); console.log(`EVAL aquecimento ${i}: ${warmups.at(-1).ms} ms`); }
  const restart1 = await hostStep('restart-api');
  const samples = [];
  for (let i = 1; i <= SAMPLES; i++) {
    const s = await generate(ref, WARMUPS + i); samples.push(s);
    if (s.status !== 'PRONTA') console.log(`CASE-FAIL amostra ${i}: ${s.status}`);
    if (i % 5 === 0) console.log(`EVAL ${i}/30 amostras; última ${s.ms} ms`);
  }
  const seriesHwm = Number(await hostStep('read-hwm'));
  const times = samples.map(s => s.ms).filter(x => x !== null).sort((x, y) => x - y);
  const p95 = times.length === SAMPLES ? times[28] : null;

  console.log('EVAL teste de limite: 200 movimentações, 200 anexos de 512 KiB (100 MiB)');
  const limit = await workspace('Synthetic C06 limite', 200, 200);
  const restart2 = await hostStep('restart-api');
  const limitRun = await generate(limit, 1);
  const limitHwm = Number(await hostStep('read-hwm'));
  const limitDocs = (await admin.query(`SELECT count(*)::int n, coalesce(sum(size_bytes),0)::bigint b FROM mimir.documents WHERE workspace_id=$1`, [limit.A.workspaceId])).rows[0];

  const allReady = samples.every(s => s.status === 'PRONTA' && s.downloadedBytes === s.zipSize);
  const verdict = allReady && p95 !== null && p95 <= LIMIT_MS && seriesHwm <= RSS_LIMIT;
  const result = { ...env, finishedAt: new Date().toISOString(),
    criterion: 'Geração de 200 movimentações com 50 anexos (25 MiB): p95 ≤ 10 s (29ª de 30 amostras) após 3 aquecimentos; pico de RSS da API ≤ 512 MiB na geração e no download sequencial (RNF-06).',
    limits: { api: 'cpuset 0,1; 2 GiB', db: 'cpuset 0,1; 2 GiB', harness: 'cpuset 2,3', note: 'API e banco compartilham 2 núcleos e somam 4 GiB; Docker Desktop/WSL2, não host dedicado (desvio declarado).' },
    hostRestarts: [restart1, restart2],
    summary: { samples: samples.length, ready: samples.filter(s => s.status === 'PRONTA').length, p95Ms: p95, minMs: times[0] ?? null, medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
      maxMs: times.at(-1) ?? null, seriesPeakRssBytes: seriesHwm, seriesPeakRssMiB: Math.round(seriesHwm / 1048576 * 10) / 10, zipBytes: samples[0]?.zipSize ?? null, substitutions: invalidRuns.length },
    limitTest: { documents: limitDocs.n, documentBytes: Number(limitDocs.b), status: limitRun.status, ms: limitRun.ms, zipBytes: limitRun.zipSize, downloadedBytes: limitRun.downloadedBytes,
      peakRssBytes: limitHwm, peakRssMiB: Math.round(limitHwm / 1048576 * 10) / 10 },
    substitutions: invalidRuns, verdict: verdict ? 'ATENDE' : 'NAO_ATENDE', warmups, samples };
  await writeResult(result, `# Resultado C06 - Desempenho (RNF-06)

Veredito: **${verdict ? 'atende' : 'não atende'}** ao critério: ${result.criterion}

- Commit \`${env.commit}\` (tag \`poc-v1.0.0\`; produto igual à tag: ${env.productEqualToTag ? 'sim' : 'não'}); projeto \`${env.project}\`; Docker ${env.docker}; PostgreSQL ${env.postgres}; Node ${env.node}.
- Ambiente (desvio declarado): ${result.limits.note} API ${result.limits.api}; banco ${result.limits.db}; harness em ${result.limits.harness}. Máquina física: ${env.container.cpuModel} (${env.container.cpus} núcleos visíveis ao contêiner do harness), ${Math.round(env.container.memoryBytes / 1073741824)} GiB visíveis.
- API real (serviço \`api\` do \`compose.yaml\`, executor embutido, \`/tmp\` em tmpfs de 192 MB). Tempo = \`delivery_packages.created_at − delivery_operations.created_at\` (relógio do banco). Download sequencial do ZIP após cada geração. Pico de RSS = \`VmHWM\` do processo Node da API, com a API reiniciada após os aquecimentos.
- Amostras: ${result.summary.ready}/${result.summary.samples} prontas; mínimo ${result.summary.minMs} ms, mediana ${result.summary.medianMs} ms, **p95 ${result.summary.p95Ms} ms**, máximo ${result.summary.maxMs} ms; ZIP ${result.summary.zipBytes} bytes; **pico de RSS ${result.summary.seriesPeakRssMiB} MiB**.
- Teste de limite (100 MiB, sem meta de tempo): ${limitDocs.n} anexos, ${limitDocs.b} bytes; estado ${limitRun.status}; ${limitRun.ms} ms; ZIP ${limitRun.zipSize} bytes, baixado ${limitRun.downloadedBytes} bytes; pico de RSS ${result.limitTest.peakRssMiB} MiB.
- Aquecimentos (descartados): ${warmups.map(w => `${w.ms} ms`).join(', ')}.

| Amostra | Estado | Tempo (ms) | ZIP (bytes) | Baixado (bytes) |
| --- | --- | --- | --- | --- |
${samples.map((s, i) => `| ${i + 1} | ${s.status} | ${s.ms} | ${s.zipSize} | ${s.downloadedBytes} |`).join('\n')}
`);
  console.log(`VERDICT ${result.verdict} p95 ${p95} ms pico ${result.summary.seriesPeakRssMiB} MiB limite ${limitRun.status} ${result.limitTest.peakRssMiB} MiB`);
  process.exitCode = verdict ? 0 : 1;
} catch (error) {
  console.log('ERROR ' + (error.stack ?? error));
  process.exitCode = 2;
} finally { await admin.end(); }
