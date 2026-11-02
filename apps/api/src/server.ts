import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { PersistencePort } from './ports/persistence.js';
import { handleSession } from './auth/http.js';
import type { SessionHttpOptions } from './auth/http.js';
import { handleAccounts } from './accounts/http.js';
import type { AccountsPort } from './ports/accounts.js';
import { handleTransactions } from './transactions/http.js';
import type { TransactionsPort } from './ports/transactions.js';
import { documentTarget, handleDocuments } from './documents/http.js';
import type { DocumentsPort } from './ports/documents.js';
import type { PreviewPort } from './ports/preview.js';
import { handlePreview } from './preview/http.js';
import type { DeliveriesPort } from './ports/deliveries.js';
import { handleDeliveries } from './deliveries/http.js';
import type { ReimbursementsPort } from './ports/reimbursements.js';
import { handleReimbursements } from './reimbursements/http.js';
import type { PendingItemsPort } from './ports/pending-items.js';
import { handlePendingItems } from './pending/http.js';

export function createApp(persistence: PersistencePort, webRoot: string, authentication?: SessionHttpOptions, accounts?: AccountsPort, transactions?: TransactionsPort, documents?: DocumentsPort, preview?: PreviewPort, deliveries?: DeliveriesPort, reimbursements?: ReimbursementsPort, pendingItems?: PendingItemsPort) {
  return createServer({ requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    void (async () => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'");
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/api/v1/session' && authentication) { await handleSession(req, res, authentication); return; }
      if (path === '/api/v1/accounts' && authentication && accounts) { await handleAccounts(req, res, authentication, accounts); return; }
      if (path === '/api/v1/transactions' && authentication && transactions) { await handleTransactions(req, res, authentication, transactions); return; }
      const transactionItem = /^\/api\/v1\/transactions\/([^/]+)$/.exec(path);
      if (transactionItem && authentication && transactions) { await handleTransactions(req, res, authentication, transactions, transactionItem[1]!); return; }
      const question = /^\/api\/v1\/transactions\/([^/]+)\/questions$/.exec(path);
      if (question && authentication && pendingItems) { await handlePendingItems(req, res, authentication, pendingItems, { kind: 'question', transactionId: question[1]! }); return; }
      if (path === '/api/v1/pending-items' && authentication && pendingItems) { await handlePendingItems(req, res, authentication, pendingItems, { kind: 'collection' }); return; }
      const pendingItem = /^\/api\/v1\/pending-items\/([^/]+)$/.exec(path);
      if (pendingItem && authentication && pendingItems) { await handlePendingItems(req, res, authentication, pendingItems, { kind: 'item', id: pendingItem[1]! }); return; }
      if (authentication && documents) {
        const target = documentTarget(path);
        if (target) { await handleDocuments(req, res, authentication, documents, target); return; }
      }
      const monthPreview = /^\/api\/v1\/periods\/([^/]+)\/preview$/.exec(path);
      if (monthPreview && authentication && preview) { await handlePreview(req, res, authentication, preview, monthPreview[1]!); return; }
      if (path === '/api/v1/deliveries' && authentication && deliveries) { await handleDeliveries(req,res,authentication,deliveries,{ kind: 'capture' }); return; }
      const operation = /^\/api\/v1\/operations\/([^/]+)$/.exec(path);
      if (operation && authentication && deliveries) { await handleDeliveries(req,res,authentication,deliveries,{ kind: 'operation',id: operation[1]! }); return; }
      const history = /^\/api\/v1\/periods\/([^/]+)\/deliveries$/.exec(path);
      if (history && authentication && deliveries) { await handleDeliveries(req,res,authentication,deliveries,{ kind: 'history',month: history[1]! }); return; }
      const published = /^\/api\/v1\/deliveries\/([^/]+)\/(package|manifest)$/.exec(path);
      if (published && authentication && deliveries) { await handleDeliveries(req,res,authentication,deliveries,{ kind: published[2] as 'package' | 'manifest',id: published[1]! }); return; }
      if (path === '/api/v1/reimbursements' && authentication && reimbursements) { await handleReimbursements(req,res,authentication,reimbursements,{ kind: 'collection' }); return; }
      if (path === '/api/v1/reimbursements/candidates' && authentication && reimbursements) { await handleReimbursements(req,res,authentication,reimbursements,{ kind: 'candidates' }); return; }
      const reimbursement = /^\/api\/v1\/reimbursements\/([^/]+)$/.exec(path);
      if (reimbursement && authentication && reimbursements) { await handleReimbursements(req,res,authentication,reimbursements,{ kind: 'item',id: reimbursement[1]! }); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      if (path === '/health' || path === '/ready') {
        const ok = path === '/health' || await persistence.ready();
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: ok ? 'ok' : 'unavailable' })); return;
      }
      if (path.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
      const file = path === '/' ? resolve(webRoot, 'index.html') : resolve(webRoot, `.${decodeURIComponent(path)}`);
      if (!file.startsWith(resolve(webRoot) + sep)) { res.writeHead(404); res.end(); return; }
      try {
        const bytes = await readFile(file);
        const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ?
          'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type }); res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch { res.writeHead(404); res.end(); }
    })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
  });
}
