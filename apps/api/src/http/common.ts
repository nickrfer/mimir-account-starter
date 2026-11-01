import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './error.js';

export interface ApiHttpOptions {
  origins: ReadonlySet<string>;
  allowLocalHttp: boolean;
  log?: (event: { requestId: string; operation: string; status: number; durationMs: number }) => void;
}
export function cookieToken(req: IncomingMessage): string | null {
  const cookies = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith('mimir_session='));
  if (cookies.length > 1) throw new ApiError(401, 'AUTH_REQUIRED', 'Sessão ausente ou inválida');
  const token = cookies[0]?.slice('mimir_session='.length);
  return cookies.length === 1 && token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export function assertOrigin(req: IncomingMessage, options: ApiHttpOptions, required: boolean): void {
  const origin = req.headers.origin;
  if ((origin !== undefined && !options.origins.has(origin)) || (required && !origin)) {
    throw new ApiError(403, 'ORIGIN_FORBIDDEN', 'Origem não permitida');
  }
}
export async function jsonInput(req: IncomingMessage, maxBytes = 8192): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Exigido JSON UTF-8');
  }
  if (Number(req.headers['content-length'] ?? '0') > maxBytes) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Corpo excede limite');
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, exceeded = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { exceeded = true; chunks.length = 0; reject(new ApiError(413, 'REQUEST_TOO_LARGE', 'Corpo excede limite')); }
      else if (!exceeded) chunks.push(chunk);
    });
    req.once('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    req.once('error', () => reject(new ApiError(400, 'INVALID_BODY', 'Corpo inválido')));
    req.once('aborted', () => reject(new ApiError(400, 'INVALID_BODY', 'Corpo inválido')));
  });
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ApiError(400, 'INVALID_JSON', 'JSON inválido'); }
}
export async function runApiRequest(req: IncomingMessage, res: ServerResponse, operation: string, options: ApiHttpOptions,
  action: () => Promise<void>): Promise<void> {
  const requestId = randomUUID(), started = performance.now();
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try { await action(); }
  catch (error) {
    const safe = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL_ERROR', 'Falha interna');
    if (safe.retryAfter !== undefined) res.setHeader('Retry-After', String(safe.retryAfter));
    if (safe.status === 413) res.setHeader('Connection', 'close');
    res.writeHead(safe.status);
    res.end(JSON.stringify({ code: safe.code, message: safe.message, requestId }));
  } finally {
    const event = { requestId, operation, status: res.statusCode, durationMs: Math.round(performance.now() - started) };
    try { (options.log ?? (value => console.info(JSON.stringify(value))))(event); } catch { /* logs never change an outcome */ }
  }
}
