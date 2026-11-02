import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = async (path) => { const m = await import(`../../apps/api/dist/${path}`).catch(() => null); assert.ok(m, `${path} missing`); return m; };
const auto = 'DOCUMENTO_AUSENTE', doubt = 'DUVIDA_CADASTRADA';
const item = (type, status, justification = '') => ({ type, status, description: 'texto atual', justification: status === 'JUSTIFICADA' && !justification ? 'motivo atual' : justification });
const J = (text) => ({ action: 'JUSTIFY', justification: text }), RESOLVE = { action: 'RESOLVE' }, REOPEN = { action: 'REOPEN' }, EDIT = (d) => ({ action: 'EDIT', description: d });
const change = (status, justification, description = 'texto atual') => ({ kind: 'CHANGE', status, justification, description });
const NOOP = { kind: 'NOOP' }, RESOLVED = { kind: 'CONFLICT', code: 'PENDING_RESOLVED' }, AUTOMATIC = { kind: 'CONFLICT', code: 'PENDING_AUTOMATIC' };

test('I13 lifecycle: oráculo escrito à mão cobre ação × tipo × estado', async () => {
  const { decidePendingAction: d } = await load('pending/lifecycle.js');
  const table = [
    [item(auto, 'PENDENTE'), J('novo motivo'), change('JUSTIFICADA', 'novo motivo')],
    [item(auto, 'JUSTIFICADA'), J('motivo atual'), NOOP],
    [item(auto, 'JUSTIFICADA'), J('outro motivo'), change('JUSTIFICADA', 'outro motivo')],
    [item(auto, 'RESOLVIDA'), J('novo motivo'), RESOLVED],
    [item(auto, 'PENDENTE'), RESOLVE, AUTOMATIC], [item(auto, 'JUSTIFICADA'), RESOLVE, AUTOMATIC], [item(auto, 'RESOLVIDA'), RESOLVE, AUTOMATIC],
    [item(auto, 'PENDENTE'), REOPEN, AUTOMATIC], [item(auto, 'JUSTIFICADA'), REOPEN, AUTOMATIC], [item(auto, 'RESOLVIDA'), REOPEN, AUTOMATIC],
    [item(auto, 'PENDENTE'), EDIT('novo'), AUTOMATIC], [item(auto, 'JUSTIFICADA'), EDIT('novo'), AUTOMATIC], [item(auto, 'RESOLVIDA'), EDIT('novo'), AUTOMATIC],
    [item(doubt, 'PENDENTE'), J('novo motivo'), change('JUSTIFICADA', 'novo motivo')],
    [item(doubt, 'JUSTIFICADA'), J('motivo atual'), NOOP],
    [item(doubt, 'JUSTIFICADA'), J('outro motivo'), change('JUSTIFICADA', 'outro motivo')],
    [item(doubt, 'RESOLVIDA'), J('novo motivo'), RESOLVED],
    [item(doubt, 'PENDENTE'), RESOLVE, change('RESOLVIDA', '')],
    [item(doubt, 'JUSTIFICADA'), RESOLVE, change('RESOLVIDA', 'motivo atual')],
    [item(doubt, 'RESOLVIDA'), RESOLVE, NOOP],
    [item(doubt, 'PENDENTE'), REOPEN, NOOP],
    [item(doubt, 'JUSTIFICADA'), REOPEN, change('PENDENTE', '')],
    [item(doubt, 'RESOLVIDA', 'motivo antigo'), REOPEN, change('PENDENTE', '')],
    [item(doubt, 'PENDENTE'), EDIT('texto novo'), change('PENDENTE', '', 'texto novo')],
    [item(doubt, 'JUSTIFICADA'), EDIT('texto novo'), change('JUSTIFICADA', 'motivo atual', 'texto novo')],
    [item(doubt, 'PENDENTE'), EDIT('texto atual'), NOOP],
    [item(doubt, 'RESOLVIDA'), EDIT('texto novo'), RESOLVED],
    [item(doubt, 'RESOLVIDA'), EDIT('texto atual'), RESOLVED]
  ];
  for (const [current, command, expected] of table) {
    assert.deepEqual(d(current, command), expected, `${current.type}/${current.status} ${command.action}`);
  }
});

test('I13 entrada: ação exata, texto normalizado 3–2.000 e revisão', async () => {
  const { pendingActionInput: p, questionInput: q } = await load('pending/input.js');
  assert.deepEqual(p({ action: 'JUSTIFY', justification: '  Café\r\nnota ', expectedRevision: 3 }), { command: { action: 'JUSTIFY', justification: 'Café\nnota' }, expectedRevision: 3 });
  assert.deepEqual(p({ action: 'RESOLVE', expectedRevision: 1 }), { command: { action: 'RESOLVE' }, expectedRevision: 1 });
  assert.deepEqual(p({ action: 'REOPEN', expectedRevision: 1 }), { command: { action: 'REOPEN' }, expectedRevision: 1 });
  assert.deepEqual(p({ action: 'EDIT', description: ' novo texto ', expectedRevision: 2 }), { command: { action: 'EDIT', description: 'novo texto' }, expectedRevision: 2 });
  assert.equal(p({ action: 'JUSTIFY', justification: 'a'.repeat(2000), expectedRevision: 1 }).command.justification.length, 2000);
  const bad = [null, [], 'x', {}, { expectedRevision: 1 }, { action: 'JUSTIFY', expectedRevision: 1 }, { action: 'JUSTIFY', justification: 'ab', expectedRevision: 1 },
    { action: 'JUSTIFY', justification: '   ab   ', expectedRevision: 1 }, { action: 'JUSTIFY', justification: 'a'.repeat(2001), expectedRevision: 1 },
    { action: 'JUSTIFY', justification: 5, expectedRevision: 1 }, { action: 'JUSTIFY', justification: 'abc' },
    { action: 'JUSTIFY', justification: 'abc', expectedRevision: 0 }, { action: 'JUSTIFY', justification: 'abc', expectedRevision: 1.5 },
    { action: 'JUSTIFY', justification: 'abc', expectedRevision: '1' }, { action: 'JUSTIFY', justification: 'abc', expectedRevision: 1, extra: 1 },
    { action: 'RESOLVE', expectedRevision: 1, justification: 'abc' }, { action: 'REOPEN', expectedRevision: 1, description: 'abc' },
    { action: 'EDIT', expectedRevision: 1 }, { action: 'EDIT', description: 'ab', expectedRevision: 1 }, { action: 'EDIT', description: 'abc', justification: 'abc', expectedRevision: 1 },
    { action: 'DELETE', expectedRevision: 1 }, { action: 'resolve', expectedRevision: 1 }];
  for (const value of bad) assert.throws(() => p(value), { code: 'INVALID_INPUT', status: 422 }, JSON.stringify(value));
  assert.deepEqual(q({ description: ' Dúvida\r\nsobre nota ', expectedRevision: 4 }), { description: 'Dúvida\nsobre nota', expectedRevision: 4 });
  for (const value of [{}, { description: 'ab', expectedRevision: 1 }, { description: 'abc' }, { description: 'abc', expectedRevision: 0 },
    { description: 'abc', expectedRevision: 1, justification: 'abc' }, { description: 'a'.repeat(2001), expectedRevision: 1 }]) {
    assert.throws(() => q(value), { code: 'INVALID_INPUT', status: 422 }, JSON.stringify(value));
  }
});

test('I13 listagem: query, limite e cursor posicional <TIPO>_<uuid>', async () => {
  const { pendingListQuery: l } = await load('pending/input.js');
  const uuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  assert.deepEqual(l(new URLSearchParams('periodMonth=2024-02')), { month: '2024-02', page: { limit: 100, cursor: null } });
  assert.deepEqual(l(new URLSearchParams(`periodMonth=2024-02&limit=200&cursor=DUVIDA_CADASTRADA_${uuid.toUpperCase()}`)),
    { month: '2024-02', page: { limit: 200, cursor: { type: 'DUVIDA_CADASTRADA', id: uuid } } });
  for (const q of ['', 'limit=5', 'periodMonth=2024-02&limit=0', 'periodMonth=2024-02&limit=201', 'periodMonth=2024-02&limit=01', 'periodMonth=2024-02&x=1',
    'periodMonth=2024-02&periodMonth=2024-03', `periodMonth=2024-02&cursor=OUTRO_${uuid}`, 'periodMonth=2024-02&cursor=DUVIDA_CADASTRADA_x',
    `periodMonth=2024-02&cursor=${uuid}`, `periodMonth=2024-02&cursor=2024-02-01_${uuid}`]) {
    assert.throws(() => l(new URLSearchParams(q)), { status: 400 }, q);
  }
  assert.throws(() => l(new URLSearchParams('periodMonth=2024-13')), { status: 422 });
});
