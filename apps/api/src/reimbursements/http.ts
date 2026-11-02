import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionHttpOptions } from '../auth/http.js';
import { sessionHash } from '../auth/service.js';
import { assertOrigin, cookieToken, jsonInput, runApiRequest } from '../http/common.js';
import { ApiError } from '../http/error.js';
import type { ReimbursementsPort } from '../ports/reimbursements.js';
import { candidatesQuery, linkId, listQuery, reimbursementInput, revisionInput } from './input.js';

export type ReimbursementTarget = { kind: 'collection' } | { kind: 'candidates' } | { kind: 'item'; id: string };

export function handleReimbursements(req: IncomingMessage, res: ServerResponse, options: SessionHttpOptions,
  reimbursements: ReimbursementsPort, target: ReimbursementTarget): Promise<void> {
  const mutating = (target.kind === 'collection' && req.method === 'POST') || (target.kind === 'item' && req.method === 'DELETE');
  return runApiRequest(req, res, `reimbursements.${target.kind}.${req.method ?? 'unknown'}`, options, async () => {
    const token = cookieToken(req), csrf = req.headers['x-csrf-token'];
    const context = mutating ? await options.service.authorizeMutation(token, typeof csrf === 'string' ? csrf : undefined) : await options.service.session(token);
    assertOrigin(req, options, mutating);
    const actor = { userId: context.userId, workspaceId: context.workspace.workspaceId, tokenHash: sessionHash(token!) };
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    if (target.kind === 'collection' && req.method === 'POST') {
      if (query.size) throw new ApiError(400, 'INVALID_QUERY', 'Parâmetros não permitidos');
      const result = await reimbursements.create(actor, reimbursementInput(await jsonInput(req, 32768)));
      res.writeHead(201); res.end(JSON.stringify(result));
    } else if (target.kind === 'collection' && req.method === 'GET') {
      const { month, page } = listQuery(query);
      const result = await reimbursements.list(actor, month, page);
      res.writeHead(200); res.end(JSON.stringify(result));
    } else if (target.kind === 'candidates' && req.method === 'GET') {
      const result = await reimbursements.candidates(actor, candidatesQuery(query));
      res.writeHead(200); res.end(JSON.stringify(result));
    } else if (target.kind === 'item' && req.method === 'DELETE') {
      if (query.size) throw new ApiError(400, 'INVALID_QUERY', 'Parâmetros não permitidos');
      const id = linkId(target.id);
      const result = await reimbursements.undo(actor, id, revisionInput(await jsonInput(req, 1024)));
      res.writeHead(200); res.end(JSON.stringify(result));
    } else throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido');
  });
}
