import { parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
// A new process gets only the allowlist. No administrative file is read.
const config = parseEnv(await readFile(new URL('../../.env.runtime', import.meta.url), 'utf8'));
const env = Object.fromEntries(['APP_DATABASE_URL', 'HOST', 'PORT', 'APP_ORIGINS', 'ALLOW_LOCAL_HTTP'].filter(key => config[key] !== undefined).map(key => [key, config[key]]));
const child = spawn(process.execPath, ['apps/api/dist/index.js'], { env, stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
