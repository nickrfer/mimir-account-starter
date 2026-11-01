import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionHttpOptions } from '../auth/http.js';
import { sessionHash } from '../auth/service.js';
import { assertOrigin, cookieToken, jsonInput, runApiRequest } from '../http/common.js';
import { ApiError } from '../http/error.js';
import { accountPageInput } from '../accounts/input.js';
import { previewMonth } from '../preview/http.js';
import { captureInput, idempotencyKey, operationId } from './input.js';
import type { DeliveriesPort } from '../ports/deliveries.js';

export function handleDeliveries(req: IncomingMessage, res: ServerResponse, options: SessionHttpOptions, deliveries: DeliveriesPort,
  target: { kind: 'capture' } | { kind: 'operation'; id: string } | { kind: 'history'; month: string } | { kind: 'package' | 'manifest'; id: string }): Promise<void> {
  return runApiRequest(req, res, `deliveries.${target.kind}`, options, async () => {
    const token = cookieToken(req), csrf = req.headers['x-csrf-token'];
    const mutating = target.kind === 'capture' && req.method === 'POST';
    const context = mutating ? await options.service.authorizeMutation(token, typeof csrf === 'string' ? csrf : undefined) : await options.service.session(token);
    assertOrigin(req, options, mutating);
    const actor = { userId: context.userId, workspaceId: context.workspace.workspaceId, tokenHash: sessionHash(token!) };
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    if (target.kind === 'capture' && req.method === 'POST') {
      if (query.size) throw new ApiError(400, 'INVALID_QUERY', 'Parâmetros não permitidos');
      const key = idempotencyKey(req.headers['idempotency-key']);
      const result = await deliveries.captureDelivery(actor, captureInput(await jsonInput(req, 16384)), key);
      res.writeHead(result.status); res.end(JSON.stringify(result.operation));
    } else if (target.kind === 'operation' && req.method === 'GET') {
      if (query.size) throw new ApiError(400, 'INVALID_QUERY', 'Parâmetros não permitidos');
      const result = await deliveries.getOperation(actor, operationId(target.id));
      res.writeHead(200); res.end(JSON.stringify(result));
    } else if (target.kind === 'history' && req.method === 'GET') {
      const result = await deliveries.listDeliveries(actor, previewMonth(target.month), accountPageInput(query));
      res.writeHead(200); res.end(JSON.stringify(result));
    } else if ((target.kind === 'package' || target.kind === 'manifest') && req.method === 'GET') {
      if (query.size) throw new ApiError(400, 'INVALID_QUERY', 'Parâmetros não permitidos');
      const file = await deliveries.readPublishedFile(actor, operationId(target.id), target.kind);
      const zip = target.kind === 'package';
      res.setHeader('Content-Type', zip ? 'application/zip' : 'application/json; charset=utf-8');
      res.setHeader('Content-Length', String(file.bytes.length));
      res.setHeader('X-Content-SHA256', file.sha256);
      if (zip) res.setHeader('Content-Disposition', `attachment; filename="entrega-${file.periodMonth}-v${file.versionNumber}.zip"`);
      res.writeHead(200); res.end(file.bytes);
    } else throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido');
  });
}
