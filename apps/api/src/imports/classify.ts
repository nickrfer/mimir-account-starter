import type { NormalizedRecord, ValidRow } from './rows.js';

export type ImportStatus = 'NOVA' | 'IGNORADA' | 'REPETIDA' | 'CONFLITO' | 'INVALIDA';
export interface ExistingOrigin { fingerprint: string; transactionStatus: 'ATIVA' | 'EXCLUIDA' }
export interface ClassifiedRow { line: number; externalId: string | null; status: ImportStatus; code: string | null; message: string | null; fingerprint: string | null }
export interface ImportTotals { rows: number; new: number; ignored: number; repeated: number; conflicting: number; invalid: number }
export interface Classification { rows: ClassifiedRow[]; totals: ImportTotals; newRows: ValidRow[] }

const conflictMessages: Record<string, string> = {
  DUPLICATE_KEY_DIFFERENT_CONTENT: 'Mesmo external_id com conteúdo diferente no arquivo',
  ORIGIN_CHANGED: 'Origem já importada com conteúdo diferente',
  ORIGIN_DELETED: 'Origem já importada em lançamento excluído; não é restaurada',
};

export function classifyImport(records: readonly NormalizedRecord[], origins: ReadonlyMap<string, ExistingOrigin>): Classification {
  const fingerprintsByKey = new Map<string, Set<string>>();
  for (const record of records) if (record.ok) {
    const set = fingerprintsByKey.get(record.row.externalId) ?? new Set<string>();
    set.add(record.fingerprint); fingerprintsByKey.set(record.row.externalId, set);
  }
  const seen = new Set<string>(), newRows: ValidRow[] = [];
  const rows = records.map((record): ClassifiedRow => {
    if (!record.ok) return { line: record.line, externalId: record.externalId, status: 'INVALIDA', code: record.code, message: record.message, fingerprint: null };
    const key = record.row.externalId, base = { line: record.line, externalId: key, fingerprint: record.fingerprint };
    const conflict = (code: string): ClassifiedRow => ({ ...base, status: 'CONFLITO', code, message: conflictMessages[code]! });
    if (fingerprintsByKey.get(key)!.size > 1) return conflict('DUPLICATE_KEY_DIFFERENT_CONTENT');
    const origin = origins.get(key);
    if (origin && origin.transactionStatus === 'EXCLUIDA') return conflict('ORIGIN_DELETED');
    if (origin && origin.fingerprint !== record.fingerprint) return conflict('ORIGIN_CHANGED');
    if (origin) return { ...base, status: 'IGNORADA', code: null, message: null };
    if (seen.has(key)) return { ...base, status: 'REPETIDA', code: null, message: null };
    seen.add(key); newRows.push(record);
    return { ...base, status: 'NOVA', code: null, message: null };
  });
  const count = (status: ImportStatus) => rows.filter(row => row.status === status).length;
  return { rows, newRows, totals: { rows: rows.length, new: count('NOVA'), ignored: count('IGNORADA'), repeated: count('REPETIDA'),
    conflicting: count('CONFLITO'), invalid: count('INVALIDA') } };
}
