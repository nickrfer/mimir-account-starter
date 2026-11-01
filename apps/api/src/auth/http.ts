import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '../http/error.js';
import { assertOrigin, cookieToken, jsonInput, runApiRequest } from '../http/common.js';
import type { ApiHttpOptions } from '../http/common.js';
import { loginInput } from './input.js';
import type { AuthenticationService } from './service.js';

export interface SessionHttpOptions extends ApiHttpOptions { service: AuthenticationService }
function cookie(token: string, secure: boolean, age: number): string {
  return `mimir_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
}
export function handleSession(req: IncomingMessage, res: ServerResponse, options: SessionHttpOptions): Promise<void> {
  const operation = ['GET', 'POST', 'DELETE'].includes(req.method ?? '') ? `session.${req.method}` : 'session.unsupported';
  return runApiRequest(req,res,operation,options,async () => {
    assertOrigin(req,options,req.method !== 'GET');
    const secure = !options.allowLocalHttp || req.headers.origin?.startsWith('https:') === true;
    if (req.method === 'POST') {
      const input = loginInput(await jsonInput(req));
      const result = await options.service.login(input.email,input.password,req.socket.remoteAddress ?? 'unknown',cookieToken(req));
      res.setHeader('Set-Cookie',cookie(result.token,secure,28800));
      res.writeHead(200); res.end(JSON.stringify(result.context));
    } else if (req.method === 'GET') {
      const context = await options.service.session(cookieToken(req));
      res.writeHead(200); res.end(JSON.stringify(context));
    } else if (req.method === 'DELETE') {
      const csrf = req.headers['x-csrf-token'];
      await options.service.logout(cookieToken(req),typeof csrf === 'string' ? csrf : undefined);
      res.setHeader('Set-Cookie',cookie('',secure,0));
      res.writeHead(204); res.end();
    } else throw new ApiError(405,'METHOD_NOT_ALLOWED','Método não permitido');
  });
}
