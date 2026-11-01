import { fileURLToPath } from 'node:url';
import { readConfig } from './config.js';
import { PostgresPersistence } from './adapters/postgres.js';
import { createApp } from './server.js';
import { PostgresAuthentication } from './adapters/postgres-auth.js';
import { AuthenticationService } from './auth/service.js';
import { PostgresAccounts } from './adapters/postgres-accounts.js';
import { PostgresTransactions } from './adapters/postgres-transactions.js';
import { PostgresDocuments } from './adapters/postgres-documents.js';
import { PostgresPreview } from './adapters/postgres-preview.js';
import { PostgresDeliveries } from './adapters/postgres-deliveries.js';
import { PostgresExecutor } from './adapters/postgres-executor.js';
import { DeliveryExecutor } from './executor/runner.js';

try {
  const config = readConfig(process.env);
  const persistence = new PostgresPersistence(config.databaseUrl);
  const authPersistence = new PostgresAuthentication(config.databaseUrl);
  const service = await AuthenticationService.create(authPersistence);
  const accounts = new PostgresAccounts(config.databaseUrl);
  const transactions = new PostgresTransactions(config.databaseUrl);
  const documents = new PostgresDocuments(config.databaseUrl);
  const preview = new PostgresPreview(config.databaseUrl);
  const deliveries = new PostgresDeliveries(config.databaseUrl);
  const executorPort = new PostgresExecutor(config.databaseUrl);
  const executor = new DeliveryExecutor(executorPort);
  await executor.start();
  const close = async () => { await executor.stop(); await Promise.all([persistence.close(), authPersistence.close(), accounts.close(), transactions.close(), documents.close(), preview.close(), deliveries.close(), executorPort.close()]); };
  const server = createApp(persistence, fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    { service, origins: config.origins, allowLocalHttp: config.allowLocalHttp }, accounts, transactions, documents, preview, deliveries);
  server.listen(config.port, config.host, () => console.log('API iniciada'));
  server.on('error', () => { console.error('Falha ao iniciar API'); process.exitCode = 1; void close(); });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000).unref();
    server.close(() => { void close().finally(() => clearTimeout(deadline)); });
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
} catch { console.error('Configuração de runtime inválida'); process.exitCode = 1; }
