import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionHttpOptions } from '../auth/http.js';
import { sessionHash } from '../auth/service.js';
import { assertOrigin, cookieToken, jsonInput, runApiRequest } from '../http/common.js';
import { ApiError } from '../http/error.js';
import type { AccountsPort } from '../ports/accounts.js';
import { accountInput, accountPageInput } from './input.js';

export function handleAccounts(req: IncomingMessage, res: ServerResponse, options: SessionHttpOptions, accounts: AccountsPort): Promise<void> {
  const operation = req.method === 'GET' ? 'accounts.GET' : req.method === 'POST' ? 'accounts.POST' : 'accounts.unsupported';
  return runApiRequest(req,res,operation,options,async () => {
    const token = cookieToken(req), csrf = req.headers['x-csrf-token'];
    const context = req.method === 'POST' ? await options.service.authorizeMutation(token,typeof csrf === 'string' ? csrf : undefined) : await options.service.session(token);
    assertOrigin(req,options,req.method === 'POST');
    const actor = { userId: context.userId, workspaceId: context.workspace.workspaceId, tokenHash: sessionHash(token!) };
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    if (req.method === 'GET') {
      const page = await accounts.list(actor,accountPageInput(query));
      res.writeHead(200); res.end(JSON.stringify(page));
    } else if (req.method === 'POST') {
      if (query.size) throw new ApiError(400, 'INVALID_QUERY', 'Parâmetros não permitidos');
      const result = await accounts.create(actor,accountInput(await jsonInput(req)));
      res.writeHead(201); res.end(JSON.stringify(result));
    } else throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido');
  });
}
