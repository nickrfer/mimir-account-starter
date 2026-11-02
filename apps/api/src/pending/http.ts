import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionHttpOptions } from '../auth/http.js';
import { sessionHash } from '../auth/service.js';
import { assertOrigin, cookieToken, jsonInput, runApiRequest } from '../http/common.js';
import { ApiError } from '../http/error.js';
import { operationId } from '../deliveries/input.js';
import type { PendingItemsPort } from '../ports/pending-items.js';
import { pendingActionInput, pendingListQuery, questionInput } from './input.js';

export type PendingTarget = { kind: 'collection' } | { kind: 'item'; id: string } | { kind: 'question'; transactionId: string };

export function handlePendingItems(req: IncomingMessage, res: ServerResponse, options: SessionHttpOptions, pending: PendingItemsPort, target: PendingTarget): Promise<void> {
  const mutating = target.kind === 'question' ? req.method === 'POST' : target.kind === 'item' && req.method === 'PATCH';
  return runApiRequest(req, res, `pending.${target.kind}.${req.method ?? 'unknown'}`, options, async () => {
    const token = cookieToken(req), csrf = req.headers['x-csrf-token'];
    const context = mutating ? await options.service.authorizeMutation(token, typeof csrf === 'string' ? csrf : undefined) : await options.service.session(token);
    assertOrigin(req, options, mutating);
    const actor = { userId: context.userId, workspaceId: context.workspace.workspaceId, tokenHash: sessionHash(token!) };
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    if (target.kind === 'collection' && req.method === 'GET') {
      const { month, page } = pendingListQuery(query);
      const result = await pending.list(actor, month, page);
      res.writeHead(200); res.end(JSON.stringify(result)); return;
    }
    if (!mutating) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido');
    if (query.size) throw new ApiError(400, 'INVALID_QUERY', 'Parâmetros não permitidos');
    if (target.kind === 'question') {
      const transactionId = operationId(target.transactionId), { description, expectedRevision } = questionInput(await jsonInput(req, 8192));
      const result = await pending.registerQuestion(actor, transactionId, description, expectedRevision);
      res.writeHead(201); res.end(JSON.stringify(result)); return;
    }
    if (target.kind === 'item') {
      const pendingId = operationId(target.id), { command, expectedRevision } = pendingActionInput(await jsonInput(req, 8192));
      const result = await pending.conduct(actor, pendingId, command, expectedRevision);
      res.writeHead(200); res.end(JSON.stringify(result)); return;
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido');
  });
}
