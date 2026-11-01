import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function setup(directory = '.', configLocation = resolve(directory).replaceAll('\\', '/')) {
  if (!configLocation || /[\r\n#"']/.test(configLocation)) throw new Error('Localização de configuração inválida');
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const files = ['.env', '.env.runtime', '.env.admin', '.local/postgres-password'];
  for (const file of files) {
    try { await access(resolve(root, file)); } catch { continue; }
    throw new Error('Configuração já existe; nenhuma credencial foi sobrescrita');
  }
  const secret = () => randomBytes(32).toString('hex');
  const postgresPassword = secret(), migratorPassword = secret(), runtimePassword = secret();
  await mkdir(resolve(root, '.local'), { recursive: true, mode: 0o700 });
  const url = (user, password) => `postgresql://${user}:${password}@db:5432/mimir`;
  const values = [
    `MIMIR_CONFIG_DIR=${configLocation}\nMIMIR_HTTP_PORT=3000\n`,
    `APP_DATABASE_URL=${url('mimir_runtime', runtimePassword)}\nHOST=0.0.0.0\nPORT=3000\n`,
    `PROVISION_DATABASE_URL=${url('postgres', postgresPassword)}\nMIGRATION_DATABASE_URL=${url('mimir_migrator', migratorPassword)}\nMIGRATOR_PASSWORD=${migratorPassword}\nAPP_ROLE_PASSWORD=${runtimePassword}\n`,
    postgresPassword
  ];
  for (let i = 0; i < files.length; i++) await writeFile(resolve(root, files[i]), values[i], { flag: 'wx', mode: 0o600 });
  console.log('Configuração local gerada; segredos omitidos');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup(process.argv[2], process.argv[3]).catch(() => { console.error('Setup falhou: configuração preexistente, localização inválida ou diretório inacessível'); process.exitCode = 1; });
}
