import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionHttpOptions } from '../auth/http.js';
import { sessionHash } from '../auth/service.js';
import { assertOrigin, cookieToken, runApiRequest } from '../http/common.js';
import { ApiError } from '../http/error.js';
import type { PreviewPort } from '../ports/preview.js';

export function previewMonth(value: string): string {
  if (!/^(19[0-9]{2}|[2-9][0-9]{3})-(0[1-9]|1[0-2])$/.test(value)) throw new ApiError(422, 'INVALID_MONTH', 'Mês inválido');
  return value;
}
export function handlePreview(req: IncomingMessage, res: ServerResponse, options: SessionHttpOptions, preview: PreviewPort, month: string): Promise<void> {
  return runApiRequest(req, res, 'preview.GET', options, async () => {
    const token = cookieToken(req), context = await options.service.session(token);
    assertOrigin(req, options, false);
    if (req.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido');
    if (new URL(req.url ?? '/', 'http://localhost').searchParams.size) throw new ApiError(400, 'INVALID_QUERY', 'Parâmetros não permitidos');
    const result = await preview.readPeriodPreview({ userId: context.userId, workspaceId: context.workspace.workspaceId, tokenHash: sessionHash(token!) }, previewMonth(month));
    res.writeHead(200); res.end(JSON.stringify(result));
  });
}
