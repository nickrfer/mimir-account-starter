import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = new URL('../../', import.meta.url);

test('I10 web: deterministic BRL cents parsing/formatting, PF/PJ rules, period navigation and verifier CLI helper', async () => {
  const mod = await import('../../apps/web/src/ledger.mjs').catch(() => null);
  assert.ok(mod, 'I10 web ledger module missing');

  // Exact BRL cents parsing without float drift
  assert.equal(mod.parseBrlCents('12,50'), 1250);
  assert.equal(mod.parseBrlCents('12.50'), 1250);
  assert.equal(mod.parseBrlCents('R$ 1.234,56'), 123456);
  assert.equal(mod.parseBrlCents('1234,5'), 123450);
  assert.equal(mod.parseBrlCents('100'), 10000);
  assert.equal(mod.parseBrlCents('0,01'), 1);
  assert.equal(mod.parseBrlCents('999999999,99'), 99999999999);
  for (const invalid of ['', '0', '0,00', '-10,00', '12,345', 'abc', '1000000000,00']) {
    assert.equal(mod.parseBrlCents(invalid), null, `Expected null for ${invalid}`);
  }
  for (const malformed of ['1.23,45', '12.34.567,89', '1.234.56,78', '00.123,45']) {
    assert.equal(mod.parseBrlCents(malformed), null, `Malformed BRL grouping accepted: ${malformed}`);
  }

  // Exact BRL formatting
  assert.equal(mod.formatBrlCents(0), 'R$ 0,00');
  assert.equal(mod.formatBrlCents(1250), 'R$ 12,50');
  assert.equal(mod.formatBrlCents(-1250), '-R$ 12,50');
  assert.equal(mod.formatBrlCents(123456), 'R$ 1.234,56');

  // Direction & PF/PJ classification rules
  assert.deepEqual(mod.allowedClassifications('ENTRADA'), ['RECEITA', 'TRANSFERENCIA', 'A_ESCLARECER']);
  assert.deepEqual(mod.allowedClassifications('SAIDA'), ['DESPESA', 'TRANSFERENCIA', 'A_ESCLARECER']);
  assert.equal(mod.canMarkPfBusinessExpense('PF', 'SAIDA', 'DESPESA'), true);
  assert.equal(mod.canMarkPfBusinessExpense('PJ', 'SAIDA', 'DESPESA'), false);
  assert.equal(mod.canMarkPfBusinessExpense('PF', 'ENTRADA', 'RECEITA'), false);
  assert.equal(mod.canMarkPfBusinessExpense('PF', 'SAIDA', 'TRANSFERENCIA'), false);

  // Civil period month validation and navigation
  assert.equal(mod.isValidPeriodMonth('2026-10'), true);
  assert.equal(mod.isValidPeriodMonth('2026-13'), false);
  assert.equal(mod.isValidPeriodMonth('1899-12'), false);
  assert.equal(mod.shiftPeriodMonth('2026-01', -1), '2025-12');
  assert.equal(mod.shiftPeriodMonth('2026-12', 1), '2027-01');
  assert.equal(mod.defaultDateForMonth('2026-10', '2026-10-15'), '2026-10-15');
  assert.equal(mod.defaultDateForMonth('2026-11', '2026-10-15'), '2026-11-01');

  // Delivery versioning & idempotency key
  assert.equal(mod.nextVersionRequiresReason([]), false);
  assert.equal(mod.nextVersionRequiresReason([{ versionNumber: 1 }]), true);
  const key = mod.generateIdempotencyKey();
  assert.match(key, /^[A-Za-z0-9_-]{16,128}$/);

  // Verifier command builder
  const cmd = mod.buildVerifierCommand('2026-10', 1);
  assert.match(cmd, /packages\/verifier\/dist\/index\.js/);
  assert.match(cmd, /entrega-2026-10-v1/);
});

test('I10 web: file selection rejects unsupported or oversized documents before upload', async () => {
  const { validateDocumentFile } = await import('../../apps/web/src/ledger.mjs');
  assert.equal(validateDocumentFile({ name: 'nota.pdf', type: 'application/pdf', size: 5 * 1024 * 1024 }), null);
  assert.equal(validateDocumentFile({ name: 'imagem.JPG', type: 'image/jpeg', size: 123 }), null);
  assert.match(validateDocumentFile({ name: 'nota.pdf', type: 'application/pdf', size: 5 * 1024 * 1024 + 1 }), /5 MiB/);
  assert.match(validateDocumentFile({ name: 'segredo.svg', type: 'image/svg+xml', size: 123 }), /PDF|PNG|JPEG/);
  assert.match(validateDocumentFile({ name: 'vazio.png', type: 'image/png', size: 0 }), /vazio/);
  assert.match(validateDocumentFile({ name: 'vazio.png', type: 'image/png', size: -1 }), /vazio/);
});

test('I10 web: logout only closes the local session after confirmed revocation or expiration', async () => {
  const { attemptLogout } = await import('../../apps/web/src/ledger.mjs');
  const calls = [];
  const request = async (url, options) => { calls.push([url, options]); return { status: 204, ok: true }; };
  assert.deepEqual(await attemptLogout('synthetic-csrf', request), { ended: true, confirmed: true });
  assert.equal(calls[0][0], '/api/v1/session');
  assert.equal(calls[0][1].method, 'DELETE');
  assert.equal(calls[0][1].headers['X-CSRF-Token'], 'synthetic-csrf');
  assert.deepEqual(await attemptLogout('synthetic-csrf', async () => ({ status: 401, ok: false })), { ended: true, confirmed: false });
  for (const status of [403, 500]) {
    assert.deepEqual(await attemptLogout('synthetic-csrf', async () => ({ status, ok: false })), { ended: false, confirmed: false });
  }
  assert.deepEqual(await attemptLogout('synthetic-csrf', async () => { throw new Error('offline'); }), { ended: false, confirmed: false });
});

test('I10 web: next action follows actual month state and never calls an old delivery current', async () => {
  const { nextMonthAction } = await import('../../apps/web/src/ledger.mjs');
  const tx = { transactionId: 'tx-1', occurredOn: '2026-10-05' };
  const base = { loaded: true, accounts: [{ id: 'acc-1' }], preview: { revision: 7, transactions: [tx], pendingItems: [] }, deliveries: [] };
  assert.deepEqual(nextMonthAction({ ...base, loaded: false }), { kind: 'loading' });
  assert.deepEqual(nextMonthAction({ ...base, preview: null }), { kind: 'loading' });
  assert.deepEqual(nextMonthAction({ ...base, accounts: [] }), { kind: 'accounts' });
  assert.deepEqual(nextMonthAction({ ...base, preview: { ...base.preview, transactions: [] } }), { kind: 'transactions' });
  const documentPending = { transactionId: 'tx-1', pendingType: 'DOCUMENTO_AUSENTE', status: 'PENDENTE' };
  const pfPending = { transactionId: 'tx-1', pendingType: 'REEMBOLSO_PF_PENDENTE', status: 'PENDENTE' };
  assert.deepEqual(nextMonthAction({ ...base, preview: { ...base.preview, pendingItems: [pfPending, documentPending] } }), { kind: 'document', transactionId: 'tx-1' });
  assert.deepEqual(nextMonthAction({ ...base, preview: { ...base.preview, pendingItems: [pfPending] } }), { kind: 'reimbursement', transactionId: 'tx-1' });
  const doubt = { transactionId: 'tx-1', pendingType: 'DUVIDA_CADASTRADA', status: 'PENDENTE' };
  assert.deepEqual(nextMonthAction({ ...base, preview: { ...base.preview, pendingItems: [doubt] } }), { kind: 'review' });
  assert.deepEqual(nextMonthAction({ ...base, preview: { ...base.preview, pendingItems: [{ ...pfPending, status: 'JUSTIFICADA' }] } }), { kind: 'capture' });
  assert.deepEqual(nextMonthAction(base), { kind: 'capture' });
  for (const status of ['EM_FILA', 'EM_PROCESSAMENTO']) {
    assert.deepEqual(nextMonthAction({ ...base, deliveries: [{ versionNumber: 1, status, capturedRevision: 7 }] }), { kind: 'delivery' });
  }
  assert.deepEqual(nextMonthAction({ ...base, deliveries: [{ versionNumber: 1, status: 'PRONTA', capturedRevision: 7 }] }), { kind: 'delivery' });
  assert.deepEqual(nextMonthAction({ ...base, deliveries: [{ versionNumber: 1, status: 'PRONTA', capturedRevision: 6 }] }), { kind: 'capture' });
  assert.deepEqual(nextMonthAction({ ...base, deliveries: [{ versionNumber: 1, status: 'FALHA', capturedRevision: 7 }] }), { kind: 'capture' });
  assert.deepEqual(nextMonthAction({ ...base, deliveries: [{ versionNumber: 2, status: 'PRONTA', capturedRevision: 6 }, { versionNumber: 1, status: 'PRONTA', capturedRevision: 7 }] }), { kind: 'capture' });
});

test('I10 web: compiled SPA bundle exposes complete first-journey endpoints and respects CSP self-only', async () => {
  const distDir = new URL('apps/web/dist/', rootDir);
  const html = await readFile(new URL('index.html', distDir), 'utf8');
  assert.match(html, /Mimir Contabilidade/);
  assert.doesNotMatch(html, /https?:\/\/fonts\./i);

  const assetsPath = fileURLToPath(new URL('assets/', distDir));
  const assetFiles = await readdir(assetsPath);
  const jsFiles = assetFiles.filter((f) => f.endsWith('.js'));
  const cssFiles = assetFiles.filter((f) => f.endsWith('.css'));
  assert.ok(jsFiles.length >= 1, 'Expected built JS bundle');
  assert.ok(cssFiles.length >= 1, 'Expected built CSS bundle');

  const jsContent = (await Promise.all(jsFiles.map((f) => readFile(join(assetsPath, f), 'utf8')))).join('\n');
  const cssContent = (await Promise.all(cssFiles.map((f) => readFile(join(assetsPath, f), 'utf8')))).join('\n');

  for (const token of [
    '/api/v1/session',
    '/api/v1/accounts',
    '/api/v1/transactions',
    '/documents',
    '/api/v1/periods/',
    '/preview',
    '/api/v1/deliveries',
    '/api/v1/operations/',
    '/package',
    '/manifest',
    'Idempotency-Key',
    'X-CSRF-Token',
  ]) {
    assert.ok(jsContent.includes(token), `Bundle missing token: ${token}`);
  }

  assert.doesNotMatch(cssContent, /@import\s+url\(['"]?https?:/i);
  assert.match(cssContent, /tabular-nums/);
});

test('I11 web: reimbursement labels and compatible inflows', async () => {
  const { reimbursementStatusLabel, roleInPeriodLabel, compatibleInflows } = await import('../../apps/web/src/ledger.mjs');
  assert.equal(reimbursementStatusLabel('NAO_APLICAVEL'), 'Não se aplica');
  assert.equal(reimbursementStatusLabel('PENDENTE_REEMBOLSO'), 'Reembolso pendente');
  assert.equal(reimbursementStatusLabel('REEMBOLSADA_NO_MES'), 'Reembolsada no mês');
  assert.equal(reimbursementStatusLabel('REEMBOLSADA_OUTRO_MES'), 'Reembolsada em outro mês');
  assert.equal(reimbursementStatusLabel('LIQUIDACAO_DE_REEMBOLSO'), 'Liquidação de reembolso');
  assert.equal(reimbursementStatusLabel('XYZ'), 'XYZ');
  assert.equal(roleInPeriodLabel('DESPESA_ORIGEM_NO_PERIODO'), 'Despesa de origem neste mês');
  assert.equal(roleInPeriodLabel('REEMBOLSO_PJ_NO_PERIODO'), 'Reembolso PJ neste mês');
  assert.equal(roleInPeriodLabel('AMBOS_NO_PERIODO'), 'Despesa e reembolso neste mês');
  assert.equal(roleInPeriodLabel('ENTRADA_PF_NO_PERIODO'), 'Entrada PF neste mês');
  assert.equal(roleInPeriodLabel('OUTRO'), 'OUTRO');
  const inflows = [{ transactionId: 'a', occurredOn: '2026-10-09' }, { transactionId: 'b', occurredOn: '2026-10-10' }, { transactionId: 'c', occurredOn: '2026-10-11' }];
  assert.deepEqual(compatibleInflows(inflows, '2026-10-10').map((i) => i.transactionId), ['b', 'c']);
  assert.deepEqual(compatibleInflows([], '2026-10-10'), []);
});

test('web: tema escuro padrao declarado em :root e cores apenas como tokens', async () => {
  const css = await readFile(new URL('apps/web/src/style.css', rootDir), 'utf8');
  const rootBlock = css.match(/:root\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(rootBlock, /color-scheme:\s*dark;/);
  const outsideRoot = css.replace(rootBlock, '');
  assert.doesNotMatch(outsideRoot, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|(?<![-\w])(white|black)(?![-\w])/);
});

test('I12 web: patch parcial de lancamento e campos bloqueados para vinculados', async () => {
  const { buildTransactionPatch, lockedFieldsForLinked } = await import('../../apps/web/src/ledger.mjs');
  const original = {
    accountId: 'a1', occurredOn: '2026-10-05', direction: 'SAIDA', amountCents: 1250,
    description: 'Hospedagem', category: 'Infra', classification: 'DESPESA', isPfBusinessExpense: false, explanation: '',
  };
  assert.equal(buildTransactionPatch(original, { ...original }), null);
  assert.equal(buildTransactionPatch(original, { ...original, description: '  Hospedagem ', explanation: '   ' }), null);
  assert.deepEqual(buildTransactionPatch(original, { ...original, amountCents: 1300, category: ' Nuvem ' }), { amountCents: 1300, category: 'Nuvem' });
  assert.deepEqual(buildTransactionPatch(original, { ...original, isPfBusinessExpense: true, occurredOn: '2026-10-06' }), { occurredOn: '2026-10-06', isPfBusinessExpense: true });
  assert.deepEqual(lockedFieldsForLinked(true), ['accountId', 'occurredOn', 'direction', 'amountCents', 'classification', 'isPfBusinessExpense']);
  assert.deepEqual(lockedFieldsForLinked(false), []);
});
