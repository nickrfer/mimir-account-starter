import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { File } from 'node:buffer';
import { ApiError } from '../http/error.js';
import { previewMonth } from '../preview/http.js';
import type { ConfirmCommand, ImportCommand } from '../ports/imports.js';

export const MAX_IMPORT_FILE_BYTES = 1048576;
const MAX_BODY_BYTES = MAX_IMPORT_FILE_BYTES + 16384;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const invalid = (message = 'Campos inválidos') => new ApiError(422, 'INVALID_INPUT', message);
const tooLarge = () => new ApiError(413, 'REQUEST_TOO_LARGE', 'Arquivo excede 1 MiB');

async function form(req: IncomingMessage, fields: readonly string[]): Promise<FormData> {
  const type = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data(?:;|$)/i.test(type)) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Exigido multipart/form-data');
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw tooLarge();
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, exceeded = false;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY_BYTES) { exceeded = true; chunks.length = 0; reject(tooLarge()); } else if (!exceeded) chunks.push(chunk); });
    req.once('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    req.once('error', () => reject(new ApiError(400, 'INVALID_BODY', 'Corpo inválido')));
    req.once('aborted', () => reject(new ApiError(400, 'INVALID_BODY', 'Corpo interrompido')));
  });
  let data: FormData;
  try { data = await new Response(new Uint8Array(bytes), { headers: { 'Content-Type': type } }).formData(); }
  catch { throw new ApiError(400, 'INVALID_BODY', 'Multipart inválido'); }
  if ([...data.keys()].length !== fields.length || fields.some(field => data.getAll(field).length !== 1)) throw invalid();
  return data;
}

function textField(data: FormData, name: string): string {
  const value = data.get(name);
  if (typeof value !== 'string') throw invalid();
  return value;
}

async function command(data: FormData): Promise<ImportCommand> {
  const accountId = textField(data, 'accountId');
  if (!UUID.test(accountId)) throw invalid('accountId inválido');
  const sourceCode = textField(data, 'sourceCode').normalize('NFC').trim();
  if (![...sourceCode].length || [...sourceCode].length > 80 || /\p{Cc}/u.test(sourceCode)) throw invalid('sourceCode deve ter de 1 a 80 caracteres, sem controles');
  if (sourceCode === 'MANUAL') throw invalid('sourceCode MANUAL é reservado a lançamentos manuais');
  const periodMonth = previewMonth(textField(data, 'periodMonth'));
  const file = data.get('file');
  if (!(file instanceof File)) throw invalid('Arquivo obrigatório');
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > MAX_IMPORT_FILE_BYTES) throw tooLarge();
  return { accountId: accountId.toLowerCase(), sourceCode, periodMonth, file: bytes, fileHash: createHash('sha256').update(bytes).digest('hex') };
}

export async function previewInput(req: IncomingMessage): Promise<ImportCommand> {
  return command(await form(req, ['file', 'accountId', 'sourceCode', 'periodMonth']));
}

export async function confirmInput(req: IncomingMessage): Promise<ConfirmCommand> {
  const data = await form(req, ['file', 'accountId', 'sourceCode', 'periodMonth', 'expectedFileHash', 'expectedRevision']);
  const base = await command(data), expectedFileHash = textField(data, 'expectedFileHash'), revision = textField(data, 'expectedRevision');
  if (!/^[0-9a-f]{64}$/.test(expectedFileHash)) throw invalid('expectedFileHash inválido');
  if (!/^[1-9][0-9]{0,15}$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw invalid('expectedRevision inválido');
  return { ...base, expectedFileHash, expectedRevision: Number(revision) };
}
