import { readdir, readFile, access } from 'node:fs/promises';
const forbidden = /^(MIGRATION_|PROVISION_|POSTGRES_|MIGRATOR_PASSWORD|APP_ROLE_PASSWORD|OPENAI_API_KEY)/;
let found = false;
for (const pid of (await readdir('/proc')).filter(value => /^\d+$/.test(value))) {
  let command;
  try { command = await readFile(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
  if (!command.startsWith('node\0') || !command.includes('apps/api/dist/index.js')) continue;
  found = true;
  const environment = await readFile(`/proc/${pid}/environ`, 'utf8');
  if (environment.split('\0').some(entry => forbidden.test(entry.split('=')[0]))) {
    console.error('administrativeCredentialsAbsent=false'); process.exit(1);
  }
}
for (const path of ['/app/.env.admin', '/app/.env.runtime', '/app/tools/admin']) {
  let present = true;
  try { await access(path); } catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
  if (present) { console.error('administrativeFilesAbsent=false'); process.exit(1); }
}
if (!found) { console.error('apiProcessFound=false'); process.exit(1); }
console.log('administrativeCredentialsAbsent=true administrativeFilesAbsent=true');
