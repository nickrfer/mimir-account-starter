import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Optional Node-host entry point. Docker orchestration stays in the native host shell.
const root = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const result = spawnSync(windows ? 'powershell.exe' : 'sh',
  windows ? ['-NoProfile', '-File', 'tools/test-docker.ps1'] : ['tools/test-docker.sh'],
  { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
