export interface RuntimeConfig { databaseUrl: string; host: string; port: number; origins: ReadonlySet<string>; allowLocalHttp: boolean }

export function readConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  // An administrative environment must fail closed, even when started manually.
  if (Object.keys(env).some(key => /^(MIGRATION_|PROVISION_|POSTGRES_|APP_ROLE_PASSWORD|MIGRATOR_PASSWORD)/.test(key))) {
    throw new Error('Configuração administrativa proibida no runtime');
  }
  const databaseUrl = env.APP_DATABASE_URL;
  if (!databaseUrl) throw new Error('APP_DATABASE_URL obrigatória');
  let url: URL;
  try { url = new URL(databaseUrl); } catch { throw new Error('APP_DATABASE_URL inválida'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'mimir_runtime' || !url.password) {
    throw new Error('Conexão de runtime inválida');
  }
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida');
  const host = env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host)) throw new Error('HOST inválido');
  if (env.ALLOW_LOCAL_HTTP !== undefined && !['true', 'false'].includes(env.ALLOW_LOCAL_HTTP)) throw new Error('ALLOW_LOCAL_HTTP inválido');
  const allowLocalHttp = env.ALLOW_LOCAL_HTTP === 'true';
  const origins = new Set((env.APP_ORIGINS ?? 'https://localhost').split(','));
  if (origins.size > 8) throw new Error('Origens excessivas');
  for (const origin of origins) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error('APP_ORIGINS inválido'); }
    if (parsed.origin !== origin || parsed.username || parsed.password ||
      (parsed.protocol !== 'https:' && !(allowLocalHttp && parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) throw new Error('APP_ORIGINS inválido');
  }
  return { databaseUrl, host, port, origins, allowLocalHttp };
}
