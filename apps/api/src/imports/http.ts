import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionHttpOptions } from '../auth/http.js';
import { sessionHash } from '../auth/service.js';
import { reserveUpload } from '../documents/multipart.js';
import { assertOrigin, cookieToken, runApiRequest } from '../http/common.js';
import { ApiError } from '../http/error.js';
import type { ImportsPort } from '../ports/imports.js';
import { confirmInput, previewInput } from './input.js';

export function handleImports(req: IncomingMessage, res: ServerResponse, options: SessionHttpOptions, imports: ImportsPort, kind: 'preview' | 'confirm'): Promise<void> {
  const mutating = kind === 'confirm' && req.method === 'POST';
  return runApiRequest(req, res, `imports.${kind}.${req.method ?? 'unknown'}`, options, async () => {
    const token = cookieToken(req), csrf = req.headers['x-csrf-token'];
    const context = mutating ? await options.service.authorizeMutation(token, typeof csrf === 'string' ? csrf : undefined) : await options.service.session(token);
    assertOrigin(req, options, mutating);
    if (req.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido');
    if (new URL(req.url ?? '/', 'http://localhost').searchParams.size) throw new ApiError(400, 'INVALID_QUERY', 'Parâmetros não permitidos');
    const actor = { userId: context.userId, workspaceId: context.workspace.workspaceId, tokenHash: sessionHash(token!) };
    const release = reserveUpload();
    try {
      if (kind === 'preview') {
        const result = await imports.preview(actor, await previewInput(req));
        res.writeHead(200); res.end(JSON.stringify(result)); return;
      }
      const { created, result } = await imports.confirm(actor, await confirmInput(req));
      res.writeHead(created ? 201 : 200); res.end(JSON.stringify(result));
    } finally { release(); }
  });
}
