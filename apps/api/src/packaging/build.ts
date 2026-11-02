import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { CapturedPayload } from '../ports/deliveries.js';
import { attachmentPath, renderCsv } from './csv.js';
import { renderSummaryHtml } from './html.js';
import { documentInclusionReasons } from './inclusion.js';
import { PackagingError, ZipFileWriter } from './zip.js';

export const MANIFEST_LIMIT_BYTES = 8 * 1024 * 1024;
const INTEGRITY_NOTICE = 'Pacote gerado pelo Mimir Account a partir de snapshot imutavel. A verificacao exige copia externa confiavel do manifesto; hashes nao equivalem a assinatura digital nem comprovam autoria.';

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

interface ManifestFile {
  path: string; role: 'RESUMO_HTML' | 'PLANILHA_CSV' | 'ANEXO_DOCUMENTO'; documentId: string | null; mimeType: string;
  sizeBytes: number; sha256: string; inclusionReasons: string[];
}

export interface BuiltPackage { zipPath: string; zipSize: number; zipHash: string; manifest: Buffer; manifestHash: string }

function files(payload: CapturedPayload, html: Buffer, csv: Buffer): ManifestFile[] {
  const inclusionReasons = documentInclusionReasons(payload);
  const attachments = payload.documents.map((document): ManifestFile => ({ path: attachmentPath(document), role: 'ANEXO_DOCUMENTO',
    documentId: document.documentId, mimeType: document.mimeType, sizeBytes: document.sizeBytes, sha256: document.sha256,
    inclusionReasons: inclusionReasons(document.documentId) }));
  const generated: ManifestFile[] = [
    { path: 'movimentacoes.csv', role: 'PLANILHA_CSV', documentId: null, mimeType: 'text/csv; charset=utf-8', sizeBytes: csv.length, sha256: sha256(csv), inclusionReasons: ['ARTEFATO_GERADO'] },
    { path: 'resumo.html', role: 'RESUMO_HTML', documentId: null, mimeType: 'text/html; charset=utf-8', sizeBytes: html.length, sha256: sha256(html), inclusionReasons: ['ARTEFATO_GERADO'] },
  ];
  return [...attachments, ...generated].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function buildManifest(payload: CapturedPayload, html: Buffer, csv: Buffer, generatedAt: Date): Buffer {
  if (payload.schemaVersion !== 'mimir.snapshot.v1' || !payload.transactions.length) throw new PackagingError('SNAPSHOT_INVALID');
  const manifest = { schemaVersion: 'mimir.manifest.v2', generatedAt: generatedAt.toISOString(), integrityNotice: INTEGRITY_NOTICE,
    workspace: payload.workspace, delivery: payload.delivery, summary: payload.summary, files: files(payload, html, csv),
    transactions: payload.transactions, contextTransactions: payload.contextTransactions,
    reimbursementLinks: payload.reimbursementLinks, pendingItems: payload.pendingItems };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  if (bytes.length > MANIFEST_LIMIT_BYTES) throw new PackagingError('MANIFEST_TOO_LARGE');
  return bytes;
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function buildPackage(payload: CapturedPayload, readDocument: (documentId: string) => Promise<Buffer>,
  workDir: string, signal: AbortSignal, generatedAt = new Date()): Promise<BuiltPackage> {
  if (payload.documents.length > 1000 || payload.documents.reduce((sum, d) => sum + d.sizeBytes, 0) > 100 * 1024 * 1024) throw new PackagingError('PACKAGE_TOO_LARGE');
  const html = renderSummaryHtml(payload), csv = renderCsv(payload), manifest = buildManifest(payload, html, csv, generatedAt);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const zipPath = join(workDir, 'package.zip');
  const zip = await ZipFileWriter.create(zipPath, new Date(payload.delivery.capturedAt));
  try {
    await zip.add({ path: 'manifesto.json', data: manifest, compress: true });
    await zip.add({ path: 'resumo.html', data: html, compress: true });
    await zip.add({ path: 'movimentacoes.csv', data: csv, compress: true });
    for (const document of [...payload.documents].sort((a, b) => (a.documentId < b.documentId ? -1 : 1))) {
      signal.throwIfAborted();
      const bytes = await readDocument(document.documentId);
      if (bytes.length !== document.sizeBytes || sha256(bytes) !== document.sha256) throw new PackagingError('DOCUMENT_INTEGRITY');
      await zip.add({ path: attachmentPath(document), data: bytes, compress: false });
    }
    signal.throwIfAborted();
    const zipSize = await zip.finish();
    return { zipPath, zipSize, zipHash: await fileHash(zipPath), manifest, manifestHash: sha256(manifest) };
  } catch (error) { await zip.abort(); throw error; }
}
