import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cliPath = resolve('packages/verifier/dist/index.js');

function extractZipToMap(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50);
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const csize = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLen = bytes.readUInt16LE(at + 28);
    const extraLen = bytes.readUInt16LE(at + 30);
    const commentLen = bytes.readUInt16LE(at + 32);
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const raw = bytes.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(data.length, size);
    assert.equal(crc32(data), crc);
    entries.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

async function prepareMutatedFixture(baseCase, rootDir, label, mutateManifest, mutateFiles) {
  const pkgDir = join(rootDir, `${label}-pkg`);
  const refPath = join(rootDir, `${label}.manifesto.json`);
  await cp(resolve('fixtures', baseCase), pkgDir, { recursive: true });
  const raw = JSON.parse(await readFile(join(pkgDir, 'manifesto.json'), 'utf8'));
  if (mutateManifest) await mutateManifest(raw, pkgDir);
  if (mutateFiles) await mutateFiles(pkgDir, raw);
  const serialized = Buffer.from(JSON.stringify(raw, null, 2) + '\n', 'utf8');
  await writeFile(join(pkgDir, 'manifesto.json'), serialized);
  await writeFile(refPath, serialized);
  return { pkgDir, refPath, manifest: raw };
}

test('I09 verifier: accepts the 3 synthetic v2 fixtures (directories and extracted ZIPs) and matches ORACULOS_DOS_EXEMPLOS', async () => {
  const mod = await import('../../packages/verifier/dist/verifier.js').catch(() => null);
  assert.ok(mod?.verifyDeliveryPackage, 'I09 verifier module missing');

  const oracles = JSON.parse(await readFile(resolve('fixtures/ORACULOS_DOS_EXEMPLOS.json'), 'utf8')).cases;
  const tempRoot = await mkdtemp(join(tmpdir(), 'mimir-i09-pos-'));
  try {
    for (const name of ['outubro_v1', 'novembro_v1', 'outubro_v2']) {
      const dirPath = resolve('fixtures', name);
      const refPath = resolve('fixtures/referencias_confiaveis', `${name}.manifesto.json`);
      const res = await mod.verifyDeliveryPackage(dirPath, refPath);
      assert.equal(res.ok, true, `${name} failed: ${res.code} ${res.message}`);
      assert.equal(res.exitCode, 0);

      const oracle = oracles[name];
      assert.equal(res.summary.businessRevenueTotalCents, oracle.revenue);
      assert.equal(res.summary.businessExpenseTotalCents, oracle.expense);
      assert.equal(res.summary.reimbursementsSettledInPeriodCents, oracle.settled);
      assert.equal(res.summary.pendingCount, oracle.pending);
      assert.equal(res.summary.justifiedCount, oracle.justified);
      assert.deepEqual(res.summary.categoryTotals, oracle.categoryTotals);
      assert.equal(res.counts.mainTransactions, oracle.main);
      assert.equal(res.counts.contextTransactions, oracle.context);
      assert.equal(res.counts.attachments, oracle.docs);

      const cli = runCli([dirPath, refPath]);
      assert.equal(cli.status, 0, cli.stderr || cli.stdout);

      // Extract ZIP fixture and verify
      const zipBytes = await readFile(resolve('fixtures/zips', `${name}.zip`));
      const extractedDir = join(tempRoot, `zip-${name}`);
      await mkdir(join(extractedDir, 'anexos'), { recursive: true });
      for (const [entryPath, data] of extractZipToMap(zipBytes)) {
        await writeFile(join(extractedDir, entryPath), data);
      }
      // Empty subdirectory inside extracted package is allowed by export-format.md
      await mkdir(join(extractedDir, 'diretorio_vazio'));
      const zipRes = await mod.verifyDeliveryPackage(extractedDir, refPath);
      assert.equal(zipRes.ok, true, `${name} zip failed: ${zipRes.code} ${zipRes.message}`);
    }

    // Explicit checks from verifier-acceptance.md:
    const novManifest = JSON.parse(await readFile(resolve('fixtures/novembro_v1/manifesto.json'), 'utf8'));
    assert.ok(!novManifest.summary.categoryTotals.some((c) => c.category === 'INFRAESTRUTURA'));
    assert.deepEqual(novManifest.summary.categoryTotals, [
      { category: 'TRANSFERENCIAS', inflowCents: 10000, outflowCents: 10000, netCents: 0 },
    ]);
    const out2Manifest = JSON.parse(await readFile(resolve('fixtures/outubro_v2/manifesto.json'), 'utf8'));
    assert.ok(!out2Manifest.summary.categoryTotals.some((c) => c.category === 'TRANSFERENCIAS'));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('I09 verifier: returns exit code 2 on invalid CLI usage, missing paths, or internal self-reference', async () => {
  const mod = await import('../../packages/verifier/dist/verifier.js').catch(() => null);
  assert.ok(mod?.verifyDeliveryPackage, 'I09 verifier module missing');

  const tempRoot = await mkdtemp(join(tmpdir(), 'mimir-i09-usage-'));
  try {
    const validDir = resolve('fixtures/outubro_v1');
    const validRef = resolve('fixtures/referencias_confiaveis/outubro_v1.manifesto.json');

    for (const args of [
      [],
      [validDir],
      [validDir, validRef, 'extra'],
      ['--unknown', validDir, validRef],
      ['--package-dir', validDir],
      ['--reference-manifest', validRef],
      [join(tempRoot, 'missing-dir'), validRef],
      [validDir, join(tempRoot, 'missing-ref.json')],
      [validRef, validRef],
      [validDir, validDir],
      [validDir, join(validDir, 'manifesto.json')],
    ]) {
      const cli = runCli(args);
      assert.equal(cli.status, 2, `Expected exit 2 for args ${JSON.stringify(args)}, got ${cli.status}`);
    }

    //Also verify --package-dir and --reference-manifest flags work when valid
    const validFlags = runCli(['--package-dir', validDir, '--reference-manifest', validRef]);
    assert.equal(validFlags.status, 0, validFlags.stderr);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('I09 verifier: rejects manifest byte mismatch, unsupported schemaVersion v1, and JSON Schema violations with exit 1', async () => {
  const mod = await import('../../packages/verifier/dist/verifier.js').catch(() => null);
  assert.ok(mod?.verifyDeliveryPackage, 'I09 verifier module missing');

  const tempRoot = await mkdtemp(join(tmpdir(), 'mimir-i09-schema-'));
  try {
    // 1. Byte mismatch between package manifesto.json and external reference
    const mismatch = await prepareMutatedFixture('outubro_v1', tempRoot, 'byte-mismatch');
    await writeFile(mismatch.refPath, (await readFile(mismatch.refPath, 'utf8')) + '\n');
    const rMismatch = await mod.verifyDeliveryPackage(mismatch.pkgDir, mismatch.refPath);
    assert.equal(rMismatch.exitCode, 1);
    assert.equal(rMismatch.code, 'MANIFEST_BYTES_MISMATCH');

    // 2. Unsupported schemaVersion v1 produces explicit version diagnostic
    const v1 = await prepareMutatedFixture('outubro_v1', tempRoot, 'v1', (m) => {
      m.schemaVersion = 'mimir.manifest.v1';
    });
    const rV1 = runCli([v1.pkgDir, v1.refPath]);
    assert.equal(rV1.status, 1);
    assert.match(rV1.stderr, /UNSUPPORTED_SCHEMA_VERSION/);
    assert.match(rV1.stderr, /mimir\.manifest\.v1/);

    // 3. Structural / schema violations
    const schemaCases = [
      ['extra-root-prop', (m) => { m.extraField = true; }],
      ['bad-workspace-currency', (m) => { m.workspace.currency = 'USD'; }],
      ['bad-period-month', (m) => { m.delivery.periodMonth = '2026-13'; }],
      ['bad-civil-date', (m) => { m.transactions[0].occurredOn = '2026-02-29'; }],
      ['bad-rfc3339', (m) => { m.generatedAt = 'not-a-timestamp'; }],
      ['bad-amount-zero', (m) => { m.transactions[0].amountCents = 0; }],
      ['bad-amount-max', (m) => { m.transactions[0].amountCents = 100000000000; }],
      ['bad-uuid', (m) => { m.transactions[0].transactionId = 'not-a-uuid'; }],
      ['extra-tx-prop', (m) => { m.transactions[0].unexpected = 1; }],
      ['missing-summary-field', (m) => { delete m.summary.pendingCount; }],
      ['empty-transactions', (m) => { m.transactions = []; }],
    ];
    for (const [label, fn] of schemaCases) {
      const c = await prepareMutatedFixture('outubro_v1', tempRoot, label, fn);
      const res = await mod.verifyDeliveryPackage(c.pkgDir, c.refPath);
      assert.equal(res.exitCode, 1, `Expected exit 1 for ${label}`);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('I09 verifier: enforces all categoryTotals and summary semantic controls (RF-09 / verifier-acceptance.md)', async () => {
  const mod = await import('../../packages/verifier/dist/verifier.js').catch(() => null);
  assert.ok(mod?.verifyDeliveryPackage, 'I09 verifier module missing');

  const tempRoot = await mkdtemp(join(tmpdir(), 'mimir-i09-cat-'));
  try {
    const cases = [
      ['cat-missing', 'outubro_v1', (m) => { delete m.summary.categoryTotals; }],
      ['cat-duplicate', 'outubro_v1', (m) => {
        m.summary.categoryTotals.push({ ...m.summary.categoryTotals[0] });
      }],
      ['cat-omitted', 'outubro_v1', (m) => {
        m.summary.categoryTotals = m.summary.categoryTotals.filter((c) => c.category !== 'TARIFAS');
      }],
      ['cat-extra-context-nov', 'novembro_v1', (m) => {
        m.summary.categoryTotals.unshift({ category: 'INFRAESTRUTURA', inflowCents: 0, outflowCents: 10000, netCents: -10000 });
      }],
      ['cat-extra-context-out2', 'outubro_v2', (m) => {
        m.summary.categoryTotals.push({ category: 'TRANSFERENCIAS', inflowCents: 10000, outflowCents: 10000, netCents: 0 });
      }],
      ['cat-wrong-inflow', 'outubro_v1', (m) => {
        m.summary.categoryTotals[1].inflowCents = 199999;
        m.summary.categoryTotals[1].netCents = 199999;
      }],
      ['cat-wrong-outflow', 'outubro_v1', (m) => {
        m.summary.categoryTotals[0].outflowCents = 9999;
        m.summary.categoryTotals[0].netCents = -9999;
      }],
      ['cat-wrong-net', 'outubro_v1', (m) => {
        m.summary.categoryTotals[0].netCents = 10000;
      }],
      ['cat-wrong-order', 'outubro_v1', (m) => {
        const [first, second, third] = m.summary.categoryTotals;
        m.summary.categoryTotals = [second, first, third];
      }],
      ['cat-not-nfc', 'outubro_v1', (m) => {
        const nfd = 'SERVIC\u0327OS';
        m.transactions[1].categoryOriginal = nfd;
        m.summary.categoryTotals[1].category = nfd;
      }],
      ['cat-untrimmed', 'outubro_v1', (m) => {
        m.transactions[1].categoryOriginal = ' SERVICOS ';
        m.summary.categoryTotals = [
          { category: ' SERVICOS ', inflowCents: 200000, outflowCents: 0, netCents: 200000 },
          m.summary.categoryTotals[0],
          m.summary.categoryTotals[2],
        ];
      }],
      ['cat-zero-net-omitted', 'novembro_v1', (m) => {
        m.summary.categoryTotals = [];
      }],
      ['summary-account-mismatch', 'outubro_v1', (m) => {
        m.summary.cashFlowByAccount[0].outflowCents = 9000;
        m.summary.cashFlowByAccount[0].netCents = -9000;
      }],
      ['summary-revenue-pf-leak', 'outubro_v1', (m) => {
        m.summary.businessRevenueTotalCents = 210000;
      }],
      ['summary-expense-mismatch', 'outubro_v1', (m) => {
        m.summary.businessExpenseTotalCents = 500;
      }],
      ['summary-settled-mismatch', 'novembro_v1', (m) => {
        m.summary.reimbursementsSettledInPeriodCents = 0;
      }],
      ['summary-pending-mismatch', 'outubro_v1', (m) => {
        m.summary.pendingCount = 0;
      }],
      ['summary-justified-mismatch', 'outubro_v1', (m) => {
        m.summary.justifiedCount = 0;
      }],
    ];

    for (const [label, baseCase, fn] of cases) {
      const c = await prepareMutatedFixture(baseCase, tempRoot, label, fn);
      const res = await mod.verifyDeliveryPackage(c.pkgDir, c.refPath);
      assert.equal(res.exitCode, 1, `Expected exit 1 for ${label}, got ${res.exitCode}`);
      // Ensure private financial description is not leaked in diagnostic message
      assert.ok(!res.message.includes('Despesa empresarial paga na PF'), `Leaked description in ${label}`);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('I09 verifier: enforces relational rules across transactions, contextTransactions, reimbursementLinks, and pendingItems', async () => {
  const mod = await import('../../packages/verifier/dist/verifier.js').catch(() => null);
  assert.ok(mod?.verifyDeliveryPackage, 'I09 verifier module missing');

  const tempRoot = await mkdtemp(join(tmpdir(), 'mimir-i09-rel-'));
  try {
    const cases = [
      ['dup-tx-id', 'novembro_v1', (m) => {
        m.contextTransactions[0].transactionId = m.transactions[0].transactionId;
      }],
      ['main-tx-wrong-month', 'outubro_v1', (m) => {
        m.transactions[0].occurredOn = '2026-11-10';
      }],
      ['ctx-tx-same-month', 'novembro_v1', (m) => {
        m.contextTransactions[0].occurredOn = '2026-11-01';
      }],
      ['orphan-ctx-tx', 'novembro_v1', (m) => {
        m.contextTransactions.push({
          ...m.contextTransactions[0],
          transactionId: '00000000-0000-4000-8000-000000000499',
          externalId: '00000000-0000-4000-8000-000000000499',
          reimbursementStatus: 'PENDENTE_REEMBOLSO',
        });
      }],
      ['link-amount-mismatch', 'novembro_v1', (m) => {
        m.reimbursementLinks[0].amountCents = 9999;
      }],
      ['link-pj-before-pf', 'novembro_v1', (m) => {
        m.contextTransactions[0].occurredOn = '2026-12-01';
      }],
      ['link-inflow-before-pj', 'novembro_v1', (m) => {
        m.transactions[1].occurredOn = '2026-11-01';
      }],
      ['link-wrong-role', 'novembro_v1', (m) => {
        m.reimbursementLinks[0].roleInPeriod = 'DESPESA_ORIGEM_NO_PERIODO';
      }],
      ['link-origin-doc-mismatch', 'novembro_v1', (m) => {
        m.reimbursementLinks[0].pfOriginDocumentIds = ['00000000-0000-4000-8000-000000000303'];
      }],
      ['tx-reimb-status-mismatch', 'outubro_v2', (m) => {
        m.transactions[0].reimbursementStatus = 'PENDENTE_REEMBOLSO';
      }],
      ['pending-on-context-tx', 'novembro_v1', (m) => {
        m.pendingItems.push({
          pendingId: '00000000-0000-4000-8000-000000000699',
          transactionId: m.contextTransactions[0].transactionId,
          pendingType: 'DOCUMENTO_AUSENTE',
          status: 'PENDENTE',
          description: 'Pendencia invalida em contexto.',
          justification: '',
        });
        m.summary.pendingCount = 1;
      }],
      ['pending-justified-empty', 'outubro_v1', (m) => {
        m.pendingItems[0].justification = 'ok';
      }],
      ['missing-doc-ref', 'outubro_v1', (m) => {
        m.transactions[0].documentIds = ['00000000-0000-4000-8000-000000000399'];
      }],
      ['wrong-inclusion-reason', 'novembro_v1', (m) => {
        m.files[0].inclusionReasons = ['VINCULO_DIRETO_PERIODO'];
      }],
    ];

    for (const [label, baseCase, fn] of cases) {
      const c = await prepareMutatedFixture(baseCase, tempRoot, label, fn);
      const res = await mod.verifyDeliveryPackage(c.pkgDir, c.refPath);
      assert.equal(res.exitCode, 1, `Expected exit 1 for ${label}, got ${res.exitCode}`);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('I09 verifier: detects missing/extra files, tampered hashes/sizes, symlinks, active HTML, and CSV tampering', async () => {
  const mod = await import('../../packages/verifier/dist/verifier.js').catch(() => null);
  assert.ok(mod?.verifyDeliveryPackage, 'I09 verifier module missing');

  const tempRoot = await mkdtemp(join(tmpdir(), 'mimir-i09-fs-'));
  try {
    // 1. Missing file
    const missing = await prepareMutatedFixture('outubro_v1', tempRoot, 'missing-file', null, async (pkgDir) => {
      await unlink(join(pkgDir, 'anexos/00000000-0000-4000-8000-000000000301.png'));
    });
    const rMissing = await mod.verifyDeliveryPackage(missing.pkgDir, missing.refPath);
    assert.equal(rMissing.exitCode, 1);
    assert.equal(rMissing.code, 'MISSING_FILE');

    // 2. Extra file
    const extra = await prepareMutatedFixture('outubro_v1', tempRoot, 'extra-file', null, async (pkgDir) => {
      await writeFile(join(pkgDir, 'anexos/intruso.txt'), 'nao listado');
    });
    const rExtra = await mod.verifyDeliveryPackage(extra.pkgDir, extra.refPath);
    assert.equal(rExtra.exitCode, 1);
    assert.equal(rExtra.code, 'EXTRA_FILE');

    // 3. Tampered attachment bytes (same size, wrong hash)
    const tampered = await prepareMutatedFixture('outubro_v1', tempRoot, 'tampered-hash', null, async (pkgDir) => {
      const p = join(pkgDir, 'anexos/00000000-0000-4000-8000-000000000301.png');
      const b = Buffer.from(await readFile(p));
      b[b.length - 1] ^= 0xff;
      await writeFile(p, b);
    });
    const rTampered = await mod.verifyDeliveryPackage(tampered.pkgDir, tampered.refPath);
    assert.equal(rTampered.exitCode, 1);
    assert.equal(rTampered.code, 'FILE_HASH_MISMATCH');

    // 4. Active HTML content injected (even with manifest size/hash updated)
    const activeHtml = await prepareMutatedFixture('outubro_v1', tempRoot, 'active-html', null, async (pkgDir, m) => {
      const htmlPath = join(pkgDir, 'resumo.html');
      const badHtml = Buffer.from((await readFile(htmlPath, 'utf8')) + '<script>alert(1)</script>', 'utf8');
      await writeFile(htmlPath, badHtml);
      const entry = m.files.find((f) => f.path === 'resumo.html');
      entry.sizeBytes = badHtml.length;
      entry.sha256 = sha256(badHtml);
    });
    const rActiveHtml = await mod.verifyDeliveryPackage(activeHtml.pkgDir, activeHtml.refPath);
    assert.equal(rActiveHtml.exitCode, 1);
    assert.equal(rActiveHtml.code, 'ACTIVE_HTML_CONTENT');

    // 5. CSV unneutralized formula (even with manifest size/hash updated)
    const badCsv = await prepareMutatedFixture('outubro_v1', tempRoot, 'bad-csv', null, async (pkgDir, m) => {
      const csvPath = join(pkgDir, 'movimentacoes.csv');
      const rawCsv = (await readFile(csvPath, 'utf8')).replace("'=TARIFA_EXEMPLO", '=TARIFA_EXEMPLO');
      const bytes = Buffer.from(rawCsv, 'utf8');
      await writeFile(csvPath, bytes);
      const entry = m.files.find((f) => f.path === 'movimentacoes.csv');
      entry.sizeBytes = bytes.length;
      entry.sha256 = sha256(bytes);
    });
    const rBadCsv = await mod.verifyDeliveryPackage(badCsv.pkgDir, badCsv.refPath);
    assert.equal(rBadCsv.exitCode, 1);
    assert.equal(rBadCsv.code, 'CSV_CONTENT_INVALID');

    // 6. Symlink inside extracted directory (if OS/permissions allow creating symlink)
    const symCase = await prepareMutatedFixture('outubro_v1', tempRoot, 'symlink-case');
    let symlinkCreated = false;
    try {
      await symlink(symCase.refPath, join(symCase.pkgDir, 'link-externo'));
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      const rSym = await mod.verifyDeliveryPackage(symCase.pkgDir, symCase.refPath);
      assert.equal(rSym.exitCode, 1);
      assert.equal(rSym.code, 'SYMLINK_FORBIDDEN');
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('I09 verifier: rejects event handlers in an otherwise hash-valid summary HTML', async () => {
  const mod = await import('../../packages/verifier/dist/verifier.js');
  const tempRoot = await mkdtemp(join(tmpdir(), 'mimir-i09-html-event-'));
  try {
    const attack = await prepareMutatedFixture('outubro_v1', tempRoot, 'html-event', null, async (pkgDir, manifest) => {
      const htmlPath = join(pkgDir, 'resumo.html');
      const html = Buffer.from((await readFile(htmlPath, 'utf8')).replace('<h1>', '<h1 onmouseover="alert(1)">'), 'utf8');
      await writeFile(htmlPath, html);
      const entry = manifest.files.find((file) => file.path === 'resumo.html');
      entry.sizeBytes = html.length;
      entry.sha256 = sha256(html);
    });
    const result = await mod.verifyDeliveryPackage(attack.pkgDir, attack.refPath);
    assert.equal(result.exitCode, 1);
    assert.equal(result.code, 'ACTIVE_HTML_CONTENT');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('I09 verifier: rejects non-UTF-8 bytes in a hash-valid summary HTML', async () => {
  const mod = await import('../../packages/verifier/dist/verifier.js');
  const tempRoot = await mkdtemp(join(tmpdir(), 'mimir-i09-html-utf8-'));
  try {
    const attack = await prepareMutatedFixture('outubro_v1', tempRoot, 'html-utf8', null, async (pkgDir, manifest) => {
      const htmlPath = join(pkgDir, 'resumo.html');
      const html = Buffer.from(await readFile(htmlPath));
      const textPosition = html.indexOf('Empresa Exemplo Sintetico');
      assert.ok(textPosition > 0);
      html[textPosition] = 0xff;
      await writeFile(htmlPath, html);
      const entry = manifest.files.find((file) => file.path === 'resumo.html');
      entry.sha256 = sha256(html);
    });
    const result = await mod.verifyDeliveryPackage(attack.pkgDir, attack.refPath);
    assert.equal(result.exitCode, 1);
    assert.equal(result.code, 'INVALID_UTF8');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('I09 verifier: rejects escaped and commented CSS imports even without a CSP meta tag', async () => {
  const mod = await import('../../packages/verifier/dist/verifier.js');
  const tempRoot = await mkdtemp(join(tmpdir(), 'mimir-i09-css-import-'));
  try {
    for (const [label, css] of [
      ['escaped', '@\\69mport u\\72l(https://example.invalid/remote.css);'],
      ['commented', '@im/**/port u\\72l(https://example.invalid/remote.css);'],
    ]) {
      const attack = await prepareMutatedFixture('outubro_v1', tempRoot, label, null, async (pkgDir, manifest) => {
        const htmlPath = join(pkgDir, 'resumo.html');
        const original = await readFile(htmlPath, 'utf8');
        assert.ok(!original.includes('Content-Security-Policy'));
        const html = Buffer.from(original.replace('</style>', `${css}</style>`), 'utf8');
        await writeFile(htmlPath, html);
        const entry = manifest.files.find((file) => file.path === 'resumo.html');
        entry.sizeBytes = html.length;
        entry.sha256 = sha256(html);
      });
      const result = await mod.verifyDeliveryPackage(attack.pkgDir, attack.refPath);
      assert.equal(result.exitCode, 1, label);
      assert.equal(result.code, 'ACTIVE_HTML_CONTENT', label);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('I09 verifier: rejects unbalanced style tags and CSS at end of HTML', async () => {
  const mod = await import('../../packages/verifier/dist/verifier.js');
  const tempRoot = await mkdtemp(join(tmpdir(), 'mimir-i09-unbalanced-style-'));
  try {
    for (const [label, htmlText] of [
      ['unterminated', '<!doctype html><html lang="pt-BR"><style>@import "https://example.invalid/x.css";'],
      ['unmatched-close', '<!doctype html><html lang="pt-BR"></style></html>'],
      ['nested', '<!doctype html><html lang="pt-BR"><style><style>body{color:#111}</style></style></html>'],
    ]) {
      const attack = await prepareMutatedFixture('outubro_v1', tempRoot, label, null, async (pkgDir, manifest) => {
        const htmlPath = join(pkgDir, 'resumo.html');
        const html = Buffer.from(htmlText, 'utf8');
        await writeFile(htmlPath, html);
        const entry = manifest.files.find((file) => file.path === 'resumo.html');
        entry.sizeBytes = html.length;
        entry.sha256 = sha256(html);
      });
      const result = await mod.verifyDeliveryPackage(attack.pkgDir, attack.refPath);
      assert.equal(result.exitCode, 1, label);
      assert.equal(result.code, 'ACTIVE_HTML_CONTENT', label);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
