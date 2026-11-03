import { ApiError } from '../http/error.js';

export const CSV_COLUMNS = ['external_id', 'occurred_on', 'direction', 'amount_cents', 'description', 'category', 'classification',
  'is_pf_business_expense', 'explanation'] as const;
export const MAX_IMPORT_ROWS = 1000;
export interface CsvRecord { line: number; fields: string[] }

const failure = (message: string) => new ApiError(422, 'INVALID_CSV', message);
const at = (line: number, message: string) => failure(`Linha ${line}: ${message}`);

function decode(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw failure('Arquivo não está em UTF-8 válido'); }
}

function records(text: string): CsvRecord[] {
  const result: CsvRecord[] = [];
  let fields: string[] = [], field = '', quoted = false, closed = false, line = 1, recordLine = 1, i = 0;
  const endField = () => { fields.push(field); field = ''; quoted = false; closed = false; };
  const endRecord = () => { endField(); result.push({ line: recordLine, fields }); fields = []; };
  while (i < text.length) {
    const char = text[i]!;
    if (quoted && !closed) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        closed = true; i++; continue;
      }
      if (char === '\n') line++;
      field += char; i++; continue;
    }
    if (char === ',') { endField(); i++; continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] !== '\n') throw at(line, 'quebra de linha inválida');
      endRecord(); i += char === '\r' ? 2 : 1; line++; recordLine = line; continue;
    }
    if (closed) throw at(recordLine, 'texto após aspas de fechamento');
    if (char === '"') {
      if (field !== '') throw at(recordLine, 'aspas no meio de um campo');
      quoted = true; i++; continue;
    }
    field += char; i++;
  }
  if (quoted && !closed) throw at(recordLine, 'aspas não fechadas');
  if (field !== '' || fields.length || quoted) endRecord();
  return result;
}

export function parseCsv(bytes: Buffer): CsvRecord[] {
  const text = decode(bytes);
  if (!text) throw failure('Arquivo vazio');
  const all = records(text), header = all[0];
  if (!header || header.fields.length !== CSV_COLUMNS.length || header.fields.some((name, index) => name !== CSV_COLUMNS[index])) {
    throw at(1, `cabeçalho deve ser exatamente ${CSV_COLUMNS.join(',')}`);
  }
  const data = all.slice(1);
  if (!data.length) throw failure('Arquivo sem linhas de dados');
  if (data.length > MAX_IMPORT_ROWS) throw failure(`Arquivo com mais de ${MAX_IMPORT_ROWS} linhas de dados`);
  for (const record of data) {
    if (record.fields.length === 1 && record.fields[0] === '') throw at(record.line, 'linha vazia; remova linhas em branco do arquivo');
    if (record.fields.length !== CSV_COLUMNS.length) throw at(record.line, `esperadas ${CSV_COLUMNS.length} colunas, encontradas ${record.fields.length}`);
  }
  return data;
}
