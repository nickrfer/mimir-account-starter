#!/usr/bin/env node
import { verifyDeliveryPackage } from './verifier.js';

function parseCliArgs(argv: readonly string[]): { packageDir: string; referenceManifest: string } | null {
  let packageDir = '';
  let referenceManifest = '';
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--package-dir') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) return null;
      packageDir = next;
      i++;
    } else if (arg === '--reference-manifest') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) return null;
      referenceManifest = next;
      i++;
    } else if (arg.startsWith('-')) {
      return null;
    } else {
      positionals.push(arg);
    }
  }

  if (packageDir || referenceManifest) {
    if (!packageDir || !referenceManifest || positionals.length > 0) return null;
    return { packageDir, referenceManifest };
  }

  if (positionals.length !== 2) return null;
  return { packageDir: positionals[0]!, referenceManifest: positionals[1]! };
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(
      'Uso: mimir-verify <diretorio-extraido> <manifesto-referencia-externo> (ou --package-dir <dir> --reference-manifest <arquivo>)'
    );
    process.exitCode = 2;
    return;
  }

  try {
    const result = await verifyDeliveryPackage(parsed.packageDir, parsed.referenceManifest);
    process.exitCode = result.exitCode;
    if (result.ok) {
      console.log(`${result.code}: ${result.message}`);
    } else {
      console.error(`${result.code}: ${result.message}`);
    }
  } catch {
    console.error('OPERATIONAL_ERROR: Falha operacional ao verificar pacote.');
    process.exitCode = 2;
  }
}

void main();
