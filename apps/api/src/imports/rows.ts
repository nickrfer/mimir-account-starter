import { createHash } from 'node:crypto';
import { civilDate } from '../domain/values.js';
import type { Classification, Direction } from '../ports/transactions.js';
import type { CsvRecord } from './csv.js';

export interface ImportRow {
  externalId: string; occurredOn: string; direction: Direction; amountCents: number; description: string; category: string;
  classification: Classification; isPfBusinessExpense: boolean; explanation: string;
}
export type RowCode = 'INVALID_FIELD' | 'OUT_OF_PERIOD' | 'INVALID_RULE';
export type ValidRow = { ok: true; line: number; row: ImportRow; fingerprint: string };
export type InvalidRow = { ok: false; line: number; externalId: string | null; code: RowCode; message: string };
export type NormalizedRecord = ValidRow | InvalidRow;

const directions: readonly Direction[] = ['ENTRADA', 'SAIDA'];
const classifications: readonly Classification[] = ['RECEITA', 'DESPESA', 'TRANSFERENCIA', 'A_ESCLARECER'];
const MAX_CENTS = 99999999999;

class RowError extends Error { constructor(readonly code: RowCode, message: string) { super(message); } }
const fieldError = (name: string, detail: string) => new RowError('INVALID_FIELD', `${name}: ${detail}`);

function text(name: string, raw: string, min: number, max: number, lineBreaks = true): string {
  const nfc = raw.normalize('NFC'), value = (lineBreaks ? nfc.replace(/\r\n?/g, '\n') : nfc).trim(), length = [...value].length;
  if (length < min || length > max || value.includes('\0')) throw fieldError(name, min ? `deve ter de ${min} a ${max} caracteres` : `deve ter até ${max} caracteres`);
  return value;
}

export function importFingerprint(row: Omit<ImportRow, 'externalId'>): string {
  const canonical = JSON.stringify([1, row.occurredOn, row.direction, row.amountCents, row.description, row.category, row.classification,
    row.isPfBusinessExpense, row.explanation]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function parse(fields: string[], periodMonth: string, accountType: 'PF' | 'PJ', setExternalId: (id: string) => void): ImportRow {
  const [rawId, rawDate, rawDirection, rawAmount, rawDescription, rawCategory, rawClassification, rawPf, rawExplanation] = fields as [string, string, string, string, string, string, string, string, string];
  const externalId = text('external_id', rawId, 1, 200, false);
  setExternalId(externalId);
  let occurredOn: string;
  try { occurredOn = civilDate(rawDate); } catch { throw fieldError('occurred_on', 'data inválida (use AAAA-MM-DD)'); }
  if (!directions.includes(rawDirection as Direction)) throw fieldError('direction', 'use ENTRADA ou SAIDA');
  if (!/^[1-9][0-9]{0,10}$/.test(rawAmount) || Number(rawAmount) > MAX_CENTS) throw fieldError('amount_cents', 'use somente dígitos de centavos, de 1 a 99999999999');
  if (!classifications.includes(rawClassification as Classification)) throw fieldError('classification', 'use RECEITA, DESPESA, TRANSFERENCIA ou A_ESCLARECER');
  if (rawPf !== 'true' && rawPf !== 'false') throw fieldError('is_pf_business_expense', 'use true ou false');
  const row: ImportRow = { externalId, occurredOn, direction: rawDirection as Direction, amountCents: Number(rawAmount),
    description: text('description', rawDescription, 1, 500), category: text('category', rawCategory, 1, 100),
    classification: rawClassification as Classification, isPfBusinessExpense: rawPf === 'true', explanation: text('explanation', rawExplanation, 0, 2000) };
  if (occurredOn.slice(0, 7) !== periodMonth) throw new RowError('OUT_OF_PERIOD', `occurred_on fora do mês ${periodMonth}`);
  if ((row.classification === 'RECEITA' && row.direction !== 'ENTRADA') || (row.classification === 'DESPESA' && row.direction !== 'SAIDA')) {
    throw new RowError('INVALID_RULE', 'RECEITA exige ENTRADA e DESPESA exige SAIDA');
  }
  if (row.isPfBusinessExpense && (row.classification !== 'DESPESA' || row.direction !== 'SAIDA' || accountType !== 'PF')) {
    throw new RowError('INVALID_RULE', 'despesa empresarial paga pela PF exige DESPESA de SAIDA em conta PF');
  }
  return row;
}

export function normalizeRow(record: CsvRecord, periodMonth: string, accountType: 'PF' | 'PJ'): NormalizedRecord {
  let externalId: string | null = null;
  try {
    const row = parse(record.fields, periodMonth, accountType, id => { externalId = id; });
    return { ok: true, line: record.line, row, fingerprint: importFingerprint(row) };
  } catch (error) {
    if (!(error instanceof RowError)) throw error;
    return { ok: false, line: record.line, externalId, code: error.code, message: error.message };
  }
}
