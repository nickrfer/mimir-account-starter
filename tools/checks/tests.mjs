import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = (await readdir('tests/unit')).filter(name => name.endsWith('.test.mjs')).map(name => `tests/unit/${name}`);
if (process.argv[2] === 'all') files.push(...(await readdir('tests/integration')).filter(name=>name.endsWith('.test.mjs')).map(name=>`tests/integration/${name}`));
else if (process.argv[2] !== 'unit') { console.error('Modo de teste inválido'); process.exit(1); }
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
