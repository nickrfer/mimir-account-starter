import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MANIFEST_LIMIT_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_LIMIT_BYTES = 5 * 1024 * 1024;
export const TOTAL_ATTACHMENTS_LIMIT_BYTES = 100 * 1024 * 1024;
export const MAX_COMBINED_TRANSACTIONS = 1000;
export const MAX_ATTACHMENTS = 1000;
export const MAX_DOCUMENT_ASSOCIATIONS = 10000;
export const MAX_TRANSACTION_AMOUNT_CENTS = 99_999_999_999;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD_MONTH_RE = /^(19[0-9]{2}|[2-9][0-9]{3})-(0[1-9]|1[0-2])$/;
const CIVIL_DATE_RE = /^(19[0-9]{2}|[2-9][0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const RFC3339_RE = /^(19[0-9]{2}|[2-9][0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FILE_PATH_RE = /^(resumo\.html|movimentacoes\.csv|anexos\/[0-9a-f-]{36}\.(pdf|png|jpg))$/;

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
};

export interface CashAccount {
  accountId: string;
  accountName: string;
  accountType: 'PF' | 'PJ';
  inflowCents: number;
  outflowCents: number;
  netCents: number;
}

export interface CategoryTotal {
  category: string;
  inflowCents: number;
  outflowCents: number;
  netCents: number;
}

export interface ManifestSummary {
  cashFlowByAccount: CashAccount[];
  businessRevenueTotalCents: number;
  businessExpenseTotalCents: number;
  reimbursementsSettledInPeriodCents: number;
  pendingCount: number;
  justifiedCount: number;
  categoryTotals: CategoryTotal[];
}

export interface VerificationResult {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  code: string;
  message: string;
  summary?: ManifestSummary;
  counts?: {
    mainTransactions: number;
    contextTransactions: number;
    attachments: number;
  };
}

interface ManifestTransaction {
  transactionId: string;
  accountId: string;
  accountName: string;
  accountType: 'PF' | 'PJ';
  occurredOn: string;
  direction: 'ENTRADA' | 'SAIDA';
  amountCents: number;
  descriptionOriginal: string;
  categoryOriginal: string;
  classification: 'RECEITA' | 'DESPESA' | 'TRANSFERENCIA' | 'A_ESCLARECER';
  isPfBusinessExpense: boolean;
  explanationOriginal: string;
  sourceType: 'MANUAL' | 'CSV';
  sourceCode: string;
  externalId: string;
  documentIds: string[];
  reimbursementStatus:
    | 'NAO_APLICAVEL'
    | 'PENDENTE_REEMBOLSO'
    | 'REEMBOLSADA_NO_MES'
    | 'REEMBOLSADA_OUTRO_MES'
    | 'LIQUIDACAO_DE_REEMBOLSO';
}

interface ManifestReimbursement {
  reimbursementLinkId: string;
  pfExpenseTransactionId: string;
  pjReimbursementTransactionId: string;
  pfInflowTransactionId: string | null;
  amountCents: number;
  pfOriginDocumentIds: string[];
  roleInPeriod:
    | 'DESPESA_ORIGEM_NO_PERIODO'
    | 'REEMBOLSO_PJ_NO_PERIODO'
    | 'AMBOS_NO_PERIODO'
    | 'ENTRADA_PF_NO_PERIODO';
}

interface ManifestPending {
  pendingId: string;
  transactionId: string;
  pendingType:
    | 'DOCUMENTO_AUSENTE'
    | 'CLASSIFICACAO_A_ESCLARECER'
    | 'REEMBOLSO_PF_PENDENTE'
    | 'DUVIDA_CADASTRADA';
  status: 'PENDENTE' | 'JUSTIFICADA' | 'RESOLVIDA';
  description: string;
  justification: string;
}

interface ManifestFile {
  path: string;
  role: 'RESUMO_HTML' | 'PLANILHA_CSV' | 'ANEXO_DOCUMENTO';
  documentId: string | null;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  inclusionReasons: string[];
}

interface ManifestV2 {
  schemaVersion: 'mimir.manifest.v2';
  generatedAt: string;
  integrityNotice: string;
  workspace: {
    workspaceId: string;
    companyName: string;
    currency: 'BRL';
  };
  delivery: {
    snapshotId: string;
    operationId: string;
    periodMonth: string;
    versionNumber: number;
    capturedRevision: number;
    rectificationReason: string;
    capturedAt: string;
  };
  summary: ManifestSummary;
  files: ManifestFile[];
  transactions: ManifestTransaction[];
  contextTransactions: ManifestTransaction[];
  reimbursementLinks: ManifestReimbursement[];
  pendingItems: ManifestPending[];
}

function fail(exitCode: 1 | 2, code: string, message: string): VerificationResult {
  return { ok: false, exitCode, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(obj);
  if (actual.length !== keys.length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function isSafeIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isStringInRange(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isValidCivilDate(value: string): boolean {
  const m = CIVIL_DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function isValidRfc3339(value: string): boolean {
  if (!RFC3339_RE.test(value)) return false;
  const datePart = value.slice(0, 10);
  return isValidCivilDate(datePart) && !Number.isNaN(Date.parse(value));
}

function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateTransactionSchema(raw: unknown, label: string): VerificationResult | null {
  if (!isPlainObject(raw)) return fail(1, 'SCHEMA_INVALID', `${label} deve ser objeto.`);
  const keys = [
    'transactionId',
    'accountId',
    'accountName',
    'accountType',
    'occurredOn',
    'direction',
    'amountCents',
    'descriptionOriginal',
    'categoryOriginal',
    'classification',
    'isPfBusinessExpense',
    'explanationOriginal',
    'sourceType',
    'sourceCode',
    'externalId',
    'documentIds',
    'reimbursementStatus',
  ];
  if (!hasExactKeys(raw, keys)) {
    return fail(1, 'SCHEMA_INVALID', `${label} possui propriedades ausentes ou extras.`);
  }
  if (typeof raw.transactionId !== 'string' || !UUID_RE.test(raw.transactionId)) {
    return fail(1, 'SCHEMA_INVALID', `${label}.transactionId inválido.`);
  }
  if (typeof raw.accountId !== 'string' || !UUID_RE.test(raw.accountId)) {
    return fail(1, 'SCHEMA_INVALID', `${label}.accountId inválido (${raw.transactionId}).`);
  }
  if (!isStringInRange(raw.accountName, 1, 200)) {
    return fail(1, 'SCHEMA_INVALID', `${label}.accountName inválido (${raw.transactionId}).`);
  }
  if (raw.accountType !== 'PF' && raw.accountType !== 'PJ') {
    return fail(1, 'SCHEMA_INVALID', `${label}.accountType inválido (${raw.transactionId}).`);
  }
  if (typeof raw.occurredOn !== 'string' || !isValidCivilDate(raw.occurredOn)) {
    return fail(1, 'SCHEMA_INVALID', `${label}.occurredOn inválido (${raw.transactionId}).`);
  }
  if (raw.direction !== 'ENTRADA' && raw.direction !== 'SAIDA') {
    return fail(1, 'SCHEMA_INVALID', `${label}.direction inválido (${raw.transactionId}).`);
  }
  if (!isSafeIntInRange(raw.amountCents, 1, MAX_TRANSACTION_AMOUNT_CENTS)) {
    return fail(1, 'SCHEMA_INVALID', `${label}.amountCents fora da faixa (${raw.transactionId}).`);
  }
  if (!isStringInRange(raw.descriptionOriginal, 1, 500)) {
    return fail(1, 'SCHEMA_INVALID', `${label}.descriptionOriginal inválido (${raw.transactionId}).`);
  }
  if (!isStringInRange(raw.categoryOriginal, 1, 100)) {
    return fail(1, 'SCHEMA_INVALID', `${label}.categoryOriginal inválido (${raw.transactionId}).`);
  }
  if (
    raw.classification !== 'RECEITA' &&
    raw.classification !== 'DESPESA' &&
    raw.classification !== 'TRANSFERENCIA' &&
    raw.classification !== 'A_ESCLARECER'
  ) {
    return fail(1, 'SCHEMA_INVALID', `${label}.classification inválido (${raw.transactionId}).`);
  }
  if (typeof raw.isPfBusinessExpense !== 'boolean') {
    return fail(1, 'SCHEMA_INVALID', `${label}.isPfBusinessExpense inválido (${raw.transactionId}).`);
  }
  if (!isStringInRange(raw.explanationOriginal, 0, 2000)) {
    return fail(1, 'SCHEMA_INVALID', `${label}.explanationOriginal inválido (${raw.transactionId}).`);
  }
  if (raw.sourceType !== 'MANUAL' && raw.sourceType !== 'CSV') {
    return fail(1, 'SCHEMA_INVALID', `${label}.sourceType inválido (${raw.transactionId}).`);
  }
  if (!isStringInRange(raw.sourceCode, 1, 80)) {
    return fail(1, 'SCHEMA_INVALID', `${label}.sourceCode inválido (${raw.transactionId}).`);
  }
  if (!isStringInRange(raw.externalId, 1, 200)) {
    return fail(1, 'SCHEMA_INVALID', `${label}.externalId inválido (${raw.transactionId}).`);
  }
  if (!Array.isArray(raw.documentIds) || raw.documentIds.length > 1000) {
    return fail(1, 'SCHEMA_INVALID', `${label}.documentIds inválido (${raw.transactionId}).`);
  }
  const seenDocs = new Set<string>();
  for (const docId of raw.documentIds) {
    if (typeof docId !== 'string' || !UUID_RE.test(docId) || seenDocs.has(docId)) {
      return fail(1, 'SCHEMA_INVALID', `${label}.documentIds contém UUID inválido ou duplicado (${raw.transactionId}).`);
    }
    seenDocs.add(docId);
  }
  const validStatuses = new Set([
    'NAO_APLICAVEL',
    'PENDENTE_REEMBOLSO',
    'REEMBOLSADA_NO_MES',
    'REEMBOLSADA_OUTRO_MES',
    'LIQUIDACAO_DE_REEMBOLSO',
  ]);
  if (typeof raw.reimbursementStatus !== 'string' || !validStatuses.has(raw.reimbursementStatus)) {
    return fail(1, 'SCHEMA_INVALID', `${label}.reimbursementStatus inválido (${raw.transactionId}).`);
  }
  return null;
}

function validateManifestSchema(raw: unknown): VerificationResult | null {
  if (!isPlainObject(raw)) {
    return fail(1, 'SCHEMA_INVALID', 'Manifesto deve ser um objeto JSON.');
  }
  if (raw.schemaVersion !== 'mimir.manifest.v2') {
    return fail(
      1,
      'UNSUPPORTED_SCHEMA_VERSION',
      `Versão de esquema não suportada: ${String(raw.schemaVersion)}. Esperado mimir.manifest.v2.`
    );
  }
  const rootKeys = [
    'schemaVersion',
    'generatedAt',
    'integrityNotice',
    'workspace',
    'delivery',
    'summary',
    'files',
    'transactions',
    'contextTransactions',
    'reimbursementLinks',
    'pendingItems',
  ];
  if (!hasExactKeys(raw, rootKeys)) {
    return fail(1, 'SCHEMA_INVALID', 'Manifesto possui propriedades raiz ausentes ou adicionais.');
  }
  if (typeof raw.generatedAt !== 'string' || !isValidRfc3339(raw.generatedAt)) {
    return fail(1, 'SCHEMA_INVALID', 'generatedAt inválido.');
  }
  if (!isStringInRange(raw.integrityNotice, 1, 1000)) {
    return fail(1, 'SCHEMA_INVALID', 'integrityNotice inválido.');
  }

  if (!isPlainObject(raw.workspace) || !hasExactKeys(raw.workspace, ['workspaceId', 'companyName', 'currency'])) {
    return fail(1, 'SCHEMA_INVALID', 'workspace inválido.');
  }
  if (
    typeof raw.workspace.workspaceId !== 'string' ||
    !UUID_RE.test(raw.workspace.workspaceId) ||
    !isStringInRange(raw.workspace.companyName, 1, 200) ||
    raw.workspace.currency !== 'BRL'
  ) {
    return fail(1, 'SCHEMA_INVALID', 'Campos de workspace inválidos.');
  }

  const deliveryKeys = [
    'snapshotId',
    'operationId',
    'periodMonth',
    'versionNumber',
    'capturedRevision',
    'rectificationReason',
    'capturedAt',
  ];
  if (!isPlainObject(raw.delivery) || !hasExactKeys(raw.delivery, deliveryKeys)) {
    return fail(1, 'SCHEMA_INVALID', 'delivery inválido.');
  }
  if (
    typeof raw.delivery.snapshotId !== 'string' ||
    !UUID_RE.test(raw.delivery.snapshotId) ||
    typeof raw.delivery.operationId !== 'string' ||
    !UUID_RE.test(raw.delivery.operationId) ||
    typeof raw.delivery.periodMonth !== 'string' ||
    !PERIOD_MONTH_RE.test(raw.delivery.periodMonth) ||
    !isSafeIntInRange(raw.delivery.versionNumber, 1, 2147483647) ||
    !isSafeIntInRange(raw.delivery.capturedRevision, 1, Number.MAX_SAFE_INTEGER) ||
    !isStringInRange(raw.delivery.rectificationReason, 0, 2000) ||
    typeof raw.delivery.capturedAt !== 'string' ||
    !isValidRfc3339(raw.delivery.capturedAt)
  ) {
    return fail(1, 'SCHEMA_INVALID', 'Campos de delivery inválidos.');
  }

  const summaryKeys = [
    'cashFlowByAccount',
    'businessRevenueTotalCents',
    'businessExpenseTotalCents',
    'reimbursementsSettledInPeriodCents',
    'pendingCount',
    'justifiedCount',
    'categoryTotals',
  ];
  if (!isPlainObject(raw.summary) || !hasExactKeys(raw.summary, summaryKeys)) {
    return fail(1, 'SCHEMA_INVALID', 'summary inválido ou incompleto.');
  }
  if (
    !Array.isArray(raw.summary.cashFlowByAccount) ||
    raw.summary.cashFlowByAccount.length > 1000 ||
    !isSafeIntInRange(raw.summary.businessRevenueTotalCents, 0, Number.MAX_SAFE_INTEGER) ||
    !isSafeIntInRange(raw.summary.businessExpenseTotalCents, 0, Number.MAX_SAFE_INTEGER) ||
    !isSafeIntInRange(raw.summary.reimbursementsSettledInPeriodCents, 0, Number.MAX_SAFE_INTEGER) ||
    !isSafeIntInRange(raw.summary.pendingCount, 0, Number.MAX_SAFE_INTEGER) ||
    !isSafeIntInRange(raw.summary.justifiedCount, 0, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(raw.summary.categoryTotals) ||
    raw.summary.categoryTotals.length > 1000
  ) {
    return fail(1, 'SCHEMA_INVALID', 'Campos numéricos ou listas de summary inválidos.');
  }

  for (const acc of raw.summary.cashFlowByAccount) {
    if (
      !isPlainObject(acc) ||
      !hasExactKeys(acc, ['accountId', 'accountName', 'accountType', 'inflowCents', 'outflowCents', 'netCents']) ||
      typeof acc.accountId !== 'string' ||
      !UUID_RE.test(acc.accountId) ||
      !isStringInRange(acc.accountName, 1, 200) ||
      (acc.accountType !== 'PF' && acc.accountType !== 'PJ') ||
      !isSafeIntInRange(acc.inflowCents, 0, Number.MAX_SAFE_INTEGER) ||
      !isSafeIntInRange(acc.outflowCents, 0, Number.MAX_SAFE_INTEGER) ||
      !isSafeIntInRange(acc.netCents, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    ) {
      return fail(1, 'SCHEMA_INVALID', 'Item de summary.cashFlowByAccount inválido.');
    }
  }

  for (const cat of raw.summary.categoryTotals) {
    if (
      !isPlainObject(cat) ||
      !hasExactKeys(cat, ['category', 'inflowCents', 'outflowCents', 'netCents']) ||
      !isStringInRange(cat.category, 1, 100) ||
      !isSafeIntInRange(cat.inflowCents, 0, Number.MAX_SAFE_INTEGER) ||
      !isSafeIntInRange(cat.outflowCents, 0, Number.MAX_SAFE_INTEGER) ||
      !isSafeIntInRange(cat.netCents, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    ) {
      return fail(1, 'SCHEMA_INVALID', 'Item de summary.categoryTotals inválido.');
    }
  }

  if (!Array.isArray(raw.files) || raw.files.length < 2 || raw.files.length > 1002) {
    return fail(1, 'SCHEMA_INVALID', 'files deve conter entre 2 e 1002 itens.');
  }
  const validRoles = new Set(['RESUMO_HTML', 'PLANILHA_CSV', 'ANEXO_DOCUMENTO']);
  const validMimes = new Set([
    'text/html; charset=utf-8',
    'text/csv; charset=utf-8',
    'application/pdf',
    'image/png',
    'image/jpeg',
  ]);
  const validReasons = new Set(['ARTEFATO_GERADO', 'VINCULO_DIRETO_PERIODO', 'CONTEXTO_REEMBOLSO']);
  for (const f of raw.files) {
    if (
      !isPlainObject(f) ||
      !hasExactKeys(f, ['path', 'role', 'documentId', 'mimeType', 'sizeBytes', 'sha256', 'inclusionReasons']) ||
      typeof f.path !== 'string' ||
      !FILE_PATH_RE.test(f.path) ||
      typeof f.role !== 'string' ||
      !validRoles.has(f.role) ||
      (f.documentId !== null && (typeof f.documentId !== 'string' || !UUID_RE.test(f.documentId))) ||
      typeof f.mimeType !== 'string' ||
      !validMimes.has(f.mimeType) ||
      !isSafeIntInRange(f.sizeBytes, 1, 115343360) ||
      typeof f.sha256 !== 'string' ||
      !SHA256_RE.test(f.sha256) ||
      !Array.isArray(f.inclusionReasons) ||
      f.inclusionReasons.length < 1
    ) {
      return fail(1, 'SCHEMA_INVALID', 'Entrada inválida em files.');
    }
    const seenReasons = new Set<string>();
    for (const r of f.inclusionReasons) {
      if (typeof r !== 'string' || !validReasons.has(r) || seenReasons.has(r)) {
        return fail(1, 'SCHEMA_INVALID', `inclusionReasons inválido em ${f.path}.`);
      }
      seenReasons.add(r);
    }
  }

  if (!Array.isArray(raw.transactions) || raw.transactions.length < 1 || raw.transactions.length > 1000) {
    return fail(1, 'SCHEMA_INVALID', 'transactions deve conter entre 1 e 1000 itens.');
  }
  for (let i = 0; i < raw.transactions.length; i++) {
    const err = validateTransactionSchema(raw.transactions[i], `transactions[${i}]`);
    if (err) return err;
  }

  if (!Array.isArray(raw.contextTransactions) || raw.contextTransactions.length > 1000) {
    return fail(1, 'SCHEMA_INVALID', 'contextTransactions excede 1000 itens ou não é lista.');
  }
  for (let i = 0; i < raw.contextTransactions.length; i++) {
    const err = validateTransactionSchema(raw.contextTransactions[i], `contextTransactions[${i}]`);
    if (err) return err;
  }

  if (!Array.isArray(raw.reimbursementLinks) || raw.reimbursementLinks.length > 1000) {
    return fail(1, 'SCHEMA_INVALID', 'reimbursementLinks inválido.');
  }
  const validRolesInPeriod = new Set([
    'DESPESA_ORIGEM_NO_PERIODO',
    'REEMBOLSO_PJ_NO_PERIODO',
    'AMBOS_NO_PERIODO',
    'ENTRADA_PF_NO_PERIODO',
  ]);
  for (const link of raw.reimbursementLinks) {
    if (
      !isPlainObject(link) ||
      !hasExactKeys(link, [
        'reimbursementLinkId',
        'pfExpenseTransactionId',
        'pjReimbursementTransactionId',
        'pfInflowTransactionId',
        'amountCents',
        'pfOriginDocumentIds',
        'roleInPeriod',
      ]) ||
      typeof link.reimbursementLinkId !== 'string' ||
      !UUID_RE.test(link.reimbursementLinkId) ||
      typeof link.pfExpenseTransactionId !== 'string' ||
      !UUID_RE.test(link.pfExpenseTransactionId) ||
      typeof link.pjReimbursementTransactionId !== 'string' ||
      !UUID_RE.test(link.pjReimbursementTransactionId) ||
      (link.pfInflowTransactionId !== null &&
        (typeof link.pfInflowTransactionId !== 'string' || !UUID_RE.test(link.pfInflowTransactionId))) ||
      !isSafeIntInRange(link.amountCents, 1, MAX_TRANSACTION_AMOUNT_CENTS) ||
      !Array.isArray(link.pfOriginDocumentIds) ||
      link.pfOriginDocumentIds.length > 1000 ||
      typeof link.roleInPeriod !== 'string' ||
      !validRolesInPeriod.has(link.roleInPeriod)
    ) {
      return fail(1, 'SCHEMA_INVALID', 'Item inválido em reimbursementLinks.');
    }
    const seenOriginDocs = new Set<string>();
    for (const d of link.pfOriginDocumentIds) {
      if (typeof d !== 'string' || !UUID_RE.test(d) || seenOriginDocs.has(d)) {
        return fail(1, 'SCHEMA_INVALID', `pfOriginDocumentIds inválido (${link.reimbursementLinkId}).`);
      }
      seenOriginDocs.add(d);
    }
  }

  if (!Array.isArray(raw.pendingItems) || raw.pendingItems.length > 4000) {
    return fail(1, 'SCHEMA_INVALID', 'pendingItems inválido.');
  }
  const validPendingTypes = new Set([
    'DOCUMENTO_AUSENTE',
    'CLASSIFICACAO_A_ESCLARECER',
    'REEMBOLSO_PF_PENDENTE',
    'DUVIDA_CADASTRADA',
  ]);
  const validPendingStatus = new Set(['PENDENTE', 'JUSTIFICADA', 'RESOLVIDA']);
  for (const p of raw.pendingItems) {
    if (
      !isPlainObject(p) ||
      !hasExactKeys(p, ['pendingId', 'transactionId', 'pendingType', 'status', 'description', 'justification']) ||
      typeof p.pendingId !== 'string' ||
      !UUID_RE.test(p.pendingId) ||
      typeof p.transactionId !== 'string' ||
      !UUID_RE.test(p.transactionId) ||
      typeof p.pendingType !== 'string' ||
      !validPendingTypes.has(p.pendingType) ||
      typeof p.status !== 'string' ||
      !validPendingStatus.has(p.status) ||
      !isStringInRange(p.description, 1, 2000) ||
      !isStringInRange(p.justification, 0, 2000)
    ) {
      return fail(1, 'SCHEMA_INVALID', 'Item inválido em pendingItems.');
    }
  }

  return null;
}

function validateSemanticsAndRelations(manifest: ManifestV2): VerificationResult | null {
  const { delivery, transactions, contextTransactions, reimbursementLinks, pendingItems, files, summary } = manifest;

  if (transactions.length + contextTransactions.length > MAX_COMBINED_TRANSACTIONS) {
    return fail(1, 'TRANSACTION_LIMIT_EXCEEDED', 'Total combinado de movimentações excede 1.000.');
  }

  const mainById = new Map<string, ManifestTransaction>();
  const contextById = new Map<string, ManifestTransaction>();
  const allById = new Map<string, ManifestTransaction>();
  const accountMeta = new Map<string, { accountName: string; accountType: 'PF' | 'PJ' }>();
  let totalDocAssociations = 0;

  for (const tx of transactions) {
    if (allById.has(tx.transactionId)) {
      return fail(1, 'DUPLICATE_TRANSACTION_ID', `transactionId duplicado: ${tx.transactionId}.`);
    }
    if (tx.occurredOn.slice(0, 7) !== delivery.periodMonth) {
      return fail(1, 'MAIN_TRANSACTION_PERIOD_MISMATCH', `Transação principal fora de ${delivery.periodMonth}: ${tx.transactionId}.`);
    }
    mainById.set(tx.transactionId, tx);
    allById.set(tx.transactionId, tx);
  }

  for (const tx of contextTransactions) {
    if (allById.has(tx.transactionId)) {
      return fail(1, 'DUPLICATE_TRANSACTION_ID', `transactionId duplicado entre principal e contexto: ${tx.transactionId}.`);
    }
    if (tx.occurredOn.slice(0, 7) === delivery.periodMonth) {
      return fail(1, 'CONTEXT_TRANSACTION_IN_PERIOD', `Transação de contexto pertence ao próprio mês ${delivery.periodMonth}: ${tx.transactionId}.`);
    }
    contextById.set(tx.transactionId, tx);
    allById.set(tx.transactionId, tx);
  }

  for (const tx of allById.values()) {
    totalDocAssociations += tx.documentIds.length;
    if (
      tx.categoryOriginal !== tx.categoryOriginal.normalize('NFC') ||
      tx.categoryOriginal !== tx.categoryOriginal.trim() ||
      tx.categoryOriginal.length === 0
    ) {
      return fail(1, 'CATEGORY_NOT_NORMALIZED', `categoryOriginal não normalizada (NFC/trim) em ${tx.transactionId}.`);
    }
    if (
      tx.descriptionOriginal !== tx.descriptionOriginal.normalize('NFC') ||
      tx.descriptionOriginal !== tx.descriptionOriginal.trim() ||
      tx.descriptionOriginal.length === 0
    ) {
      return fail(1, 'DESCRIPTION_NOT_NORMALIZED', `descriptionOriginal não normalizada em ${tx.transactionId}.`);
    }
    if (tx.classification === 'RECEITA' && tx.direction !== 'ENTRADA') {
      return fail(1, 'DIRECTION_CLASSIFICATION_MISMATCH', `RECEITA exige ENTRADA (${tx.transactionId}).`);
    }
    if (tx.classification === 'DESPESA' && tx.direction !== 'SAIDA') {
      return fail(1, 'DIRECTION_CLASSIFICATION_MISMATCH', `DESPESA exige SAIDA (${tx.transactionId}).`);
    }
    if (tx.isPfBusinessExpense && (tx.accountType !== 'PF' || tx.direction !== 'SAIDA' || tx.classification !== 'DESPESA')) {
      return fail(1, 'PF_BUSINESS_EXPENSE_INVALID', `isPfBusinessExpense inválido (${tx.transactionId}).`);
    }
    if (tx.sourceType === 'MANUAL' && (tx.sourceCode !== 'MANUAL' || tx.externalId !== tx.transactionId)) {
      return fail(1, 'MANUAL_SOURCE_INVALID', `Registro MANUAL exige sourceCode=MANUAL e externalId=transactionId (${tx.transactionId}).`);
    }
    const existingAcc = accountMeta.get(tx.accountId);
    if (!existingAcc) {
      accountMeta.set(tx.accountId, { accountName: tx.accountName, accountType: tx.accountType });
    } else if (existingAcc.accountName !== tx.accountName || existingAcc.accountType !== tx.accountType) {
      return fail(1, 'ACCOUNT_METADATA_CONFLICT', `Conflito de nome/tipo para a conta ${tx.accountId}.`);
    }
  }

  if (totalDocAssociations > MAX_DOCUMENT_ASSOCIATIONS) {
    return fail(1, 'DOCUMENT_ASSOCIATION_LIMIT_EXCEEDED', 'Total de associações registro-documento excede 10.000.');
  }

  // Validate files list and attachment references
  const seenPaths = new Set<string>();
  const attachmentByDocId = new Map<string, ManifestFile>();
  let hasHtml = false;
  let hasCsv = false;
  let totalAttachmentBytes = 0;

  for (const f of files) {
    if (seenPaths.has(f.path)) {
      return fail(1, 'DUPLICATE_FILE_PATH', `Caminho duplicado no manifesto: ${f.path}.`);
    }
    seenPaths.add(f.path);

    if (f.path === 'resumo.html') {
      if (
        f.role !== 'RESUMO_HTML' ||
        f.documentId !== null ||
        f.mimeType !== 'text/html; charset=utf-8' ||
        f.inclusionReasons.length !== 1 ||
        f.inclusionReasons[0] !== 'ARTEFATO_GERADO'
      ) {
        return fail(1, 'INVALID_GENERATED_FILE_ENTRY', 'Metadados inválidos para resumo.html.');
      }
      hasHtml = true;
    } else if (f.path === 'movimentacoes.csv') {
      if (
        f.role !== 'PLANILHA_CSV' ||
        f.documentId !== null ||
        f.mimeType !== 'text/csv; charset=utf-8' ||
        f.inclusionReasons.length !== 1 ||
        f.inclusionReasons[0] !== 'ARTEFATO_GERADO'
      ) {
        return fail(1, 'INVALID_GENERATED_FILE_ENTRY', 'Metadados inválidos para movimentacoes.csv.');
      }
      hasCsv = true;
    } else {
      if (f.role !== 'ANEXO_DOCUMENTO' || !f.documentId) {
        return fail(1, 'INVALID_ATTACHMENT_ENTRY', `Anexo inválido em ${f.path}.`);
      }
      if (attachmentByDocId.has(f.documentId)) {
        return fail(1, 'DUPLICATE_DOCUMENT_ID', `documentId duplicado em files: ${f.documentId}.`);
      }
      const ext = f.path.split('.').pop() ?? '';
      const expectedPath = `anexos/${f.documentId.toLowerCase()}.${ext}`;
      if (f.path.toLowerCase() !== expectedPath || MIME_BY_EXT[ext] !== f.mimeType) {
        return fail(1, 'ATTACHMENT_PATH_MIME_MISMATCH', `Caminho/MIME inconsistente em ${f.path}.`);
      }
      if (f.sizeBytes > ATTACHMENT_LIMIT_BYTES) {
        return fail(1, 'ATTACHMENT_TOO_LARGE', `Anexo excede 5 MiB: ${f.path}.`);
      }
      totalAttachmentBytes += f.sizeBytes;
      attachmentByDocId.set(f.documentId, f);
    }
  }

  if (!hasHtml || !hasCsv) {
    return fail(1, 'MISSING_REQUIRED_ARTIFACTS', 'files deve conter resumo.html e movimentacoes.csv.');
  }
  if (attachmentByDocId.size > MAX_ATTACHMENTS || totalAttachmentBytes > TOTAL_ATTACHMENTS_LIMIT_BYTES) {
    return fail(1, 'ATTACHMENT_VOLUME_EXCEEDED', 'Limites de anexos únicos (1.000 ou 100 MiB) excedidos.');
  }

  const directDocIds = new Set<string>();
  const contextDocIds = new Set<string>();
  for (const tx of transactions) {
    for (const d of tx.documentIds) {
      if (!attachmentByDocId.has(d)) {
        return fail(1, 'UNRESOLVED_DOCUMENT_REF', `Documento ${d} referenciado por ${tx.transactionId} ausente em files.`);
      }
      directDocIds.add(d);
    }
  }
  for (const tx of contextTransactions) {
    for (const d of tx.documentIds) {
      if (!attachmentByDocId.has(d)) {
        return fail(1, 'UNRESOLVED_DOCUMENT_REF', `Documento ${d} referenciado por contexto ${tx.transactionId} ausente em files.`);
      }
      contextDocIds.add(d);
    }
  }

  for (const [docId, fileEntry] of attachmentByDocId.entries()) {
    const expectedReasons: string[] = [];
    if (directDocIds.has(docId)) expectedReasons.push('VINCULO_DIRETO_PERIODO');
    if (contextDocIds.has(docId)) expectedReasons.push('CONTEXTO_REEMBOLSO');
    if (expectedReasons.length === 0) {
      return fail(1, 'UNREFERENCED_ATTACHMENT', `Anexo ${fileEntry.path} não é referenciado por nenhuma transação.`);
    }
    const actualSorted = [...fileEntry.inclusionReasons].sort();
    const expectedSorted = [...expectedReasons].sort();
    if (
      actualSorted.length !== expectedSorted.length ||
      actualSorted.some((v, idx) => v !== expectedSorted[idx])
    ) {
      return fail(1, 'INCLUSION_REASON_MISMATCH', `inclusionReasons divergente para ${fileEntry.path}.`);
    }
  }

  // Validate reimbursement links & context necessity
  const seenLinkIds = new Set<string>();
  const usedPfExpense = new Map<string, ManifestReimbursement>();
  const usedPjReimb = new Map<string, ManifestReimbursement>();
  const usedPfInflow = new Map<string, ManifestReimbursement>();
  const referencedContextIds = new Set<string>();

  for (const link of reimbursementLinks) {
    if (seenLinkIds.has(link.reimbursementLinkId)) {
      return fail(1, 'DUPLICATE_REIMBURSEMENT_LINK', `reimbursementLinkId duplicado: ${link.reimbursementLinkId}.`);
    }
    seenLinkIds.add(link.reimbursementLinkId);

    if (usedPfExpense.has(link.pfExpenseTransactionId)) {
      return fail(1, 'DUPLICATE_PF_EXPENSE_IN_LINKS', `Despesa PF reutilizada em vínculo: ${link.pfExpenseTransactionId}.`);
    }
    if (usedPjReimb.has(link.pjReimbursementTransactionId)) {
      return fail(1, 'DUPLICATE_PJ_REIMB_IN_LINKS', `Saída PJ reutilizada em vínculo: ${link.pjReimbursementTransactionId}.`);
    }

    const pfExpense = allById.get(link.pfExpenseTransactionId);
    const pjReimb = allById.get(link.pjReimbursementTransactionId);
    if (!pfExpense || !pjReimb) {
      return fail(1, 'UNRESOLVED_REIMBURSEMENT_TX', `Vínculo ${link.reimbursementLinkId} referencia transação inexistente.`);
    }
    if (
      pfExpense.accountType !== 'PF' ||
      pfExpense.direction !== 'SAIDA' ||
      pfExpense.classification !== 'DESPESA' ||
      !pfExpense.isPfBusinessExpense
    ) {
      return fail(1, 'INVALID_PF_EXPENSE_TX', `pfExpenseTransactionId inválido no vínculo ${link.reimbursementLinkId}.`);
    }
    if (
      pjReimb.accountType !== 'PJ' ||
      pjReimb.direction !== 'SAIDA' ||
      pjReimb.classification !== 'TRANSFERENCIA' ||
      pjReimb.isPfBusinessExpense
    ) {
      return fail(1, 'INVALID_PJ_REIMBURSEMENT_TX', `pjReimbursementTransactionId inválido no vínculo ${link.reimbursementLinkId}.`);
    }
    if (link.amountCents !== pfExpense.amountCents || link.amountCents !== pjReimb.amountCents) {
      return fail(1, 'REIMBURSEMENT_AMOUNT_MISMATCH', `Valor divergente no vínculo ${link.reimbursementLinkId}.`);
    }
    if (pjReimb.occurredOn < pfExpense.occurredOn) {
      return fail(1, 'REIMBURSEMENT_DATE_ORDER_INVALID', `Data PJ anterior à despesa PF no vínculo ${link.reimbursementLinkId}.`);
    }

    let pfInflow: ManifestTransaction | undefined;
    if (link.pfInflowTransactionId !== null) {
      if (usedPfInflow.has(link.pfInflowTransactionId)) {
        return fail(1, 'DUPLICATE_PF_INFLOW_IN_LINKS', `Entrada PF reutilizada em vínculo: ${link.pfInflowTransactionId}.`);
      }
      pfInflow = allById.get(link.pfInflowTransactionId);
      if (!pfInflow) {
        return fail(1, 'UNRESOLVED_REIMBURSEMENT_TX', `pfInflowTransactionId inexistente no vínculo ${link.reimbursementLinkId}.`);
      }
      if (
        pfInflow.accountId !== pfExpense.accountId ||
        pfInflow.accountType !== 'PF' ||
        pfInflow.direction !== 'ENTRADA' ||
        pfInflow.classification !== 'TRANSFERENCIA' ||
        pfInflow.isPfBusinessExpense ||
        pfInflow.amountCents !== link.amountCents ||
        pfInflow.occurredOn < pjReimb.occurredOn
      ) {
        return fail(1, 'INVALID_PF_INFLOW_TX', `pfInflowTransactionId inválido no vínculo ${link.reimbursementLinkId}.`);
      }
      usedPfInflow.set(link.pfInflowTransactionId, link);
    }

    const pfInPeriod = mainById.has(pfExpense.transactionId);
    const pjInPeriod = mainById.has(pjReimb.transactionId);
    const inflowInPeriod = pfInflow ? mainById.has(pfInflow.transactionId) : false;

    let expectedRole: ManifestReimbursement['roleInPeriod'] | null = null;
    if (pfInPeriod && pjInPeriod) {
      expectedRole = 'AMBOS_NO_PERIODO';
    } else if (pfInPeriod && !pjInPeriod) {
      expectedRole = 'DESPESA_ORIGEM_NO_PERIODO';
    } else if (!pfInPeriod && pjInPeriod) {
      expectedRole = 'REEMBOLSO_PJ_NO_PERIODO';
    } else if (inflowInPeriod) {
      expectedRole = 'ENTRADA_PF_NO_PERIODO';
    } else {
      return fail(1, 'UNRELATED_REIMBURSEMENT_LINK', `Vínculo ${link.reimbursementLinkId} não toca o período ${delivery.periodMonth}.`);
    }

    if (link.roleInPeriod !== expectedRole) {
      return fail(
        1,
        'REIMBURSEMENT_ROLE_MISMATCH',
        `roleInPeriod divergente em ${link.reimbursementLinkId}: esperado ${expectedRole}, recebido ${link.roleInPeriod}.`
      );
    }

    const pfDocsSorted = [...pfExpense.documentIds].sort();
    const linkDocsSorted = [...link.pfOriginDocumentIds].sort();
    if (
      pfDocsSorted.length !== linkDocsSorted.length ||
      pfDocsSorted.some((d, i) => d !== linkDocsSorted[i])
    ) {
      return fail(1, 'REIMBURSEMENT_ORIGIN_DOCS_MISMATCH', `pfOriginDocumentIds divergente em ${link.reimbursementLinkId}.`);
    }

    usedPfExpense.set(pfExpense.transactionId, link);
    usedPjReimb.set(pjReimb.transactionId, link);

    if (contextById.has(pfExpense.transactionId)) referencedContextIds.add(pfExpense.transactionId);
    if (contextById.has(pjReimb.transactionId)) referencedContextIds.add(pjReimb.transactionId);
    if (pfInflow && contextById.has(pfInflow.transactionId)) referencedContextIds.add(pfInflow.transactionId);
  }

  for (const ctxTx of contextTransactions) {
    if (!referencedContextIds.has(ctxTx.transactionId)) {
      return fail(1, 'ORPHAN_CONTEXT_TRANSACTION', `Transação de contexto sem vínculo de reembolso: ${ctxTx.transactionId}.`);
    }
  }

  // Validate reimbursementStatus on every transaction
  for (const tx of allById.values()) {
    const asPfExp = usedPfExpense.get(tx.transactionId);
    const asPjReimb = usedPjReimb.get(tx.transactionId);
    const asPfInflow = usedPfInflow.get(tx.transactionId);

    const rolesCount = (asPfExp ? 1 : 0) + (asPjReimb ? 1 : 0) + (asPfInflow ? 1 : 0);
    if (rolesCount > 1) {
      return fail(1, 'CONFLICTING_REIMBURSEMENT_ROLES', `Transação ${tx.transactionId} possui múltiplos papéis em vínculos.`);
    }

    let expectedStatus: ManifestTransaction['reimbursementStatus'];
    if (asPfExp) {
      const pjTx = allById.get(asPfExp.pjReimbursementTransactionId)!;
      expectedStatus =
        tx.occurredOn.slice(0, 7) === pjTx.occurredOn.slice(0, 7)
          ? 'REEMBOLSADA_NO_MES'
          : 'REEMBOLSADA_OUTRO_MES';
    } else if (asPjReimb || asPfInflow) {
      expectedStatus = 'LIQUIDACAO_DE_REEMBOLSO';
    } else if (tx.isPfBusinessExpense) {
      expectedStatus = 'PENDENTE_REEMBOLSO';
    } else {
      expectedStatus = 'NAO_APLICAVEL';
    }

    if (tx.reimbursementStatus !== expectedStatus) {
      return fail(
        1,
        'TRANSACTION_REIMBURSEMENT_STATUS_MISMATCH',
        `reimbursementStatus inválido em ${tx.transactionId}: esperado ${expectedStatus}, recebido ${tx.reimbursementStatus}.`
      );
    }
  }

  // Validate pendingItems
  const seenPendingIds = new Set<string>();
  const seenPendingComposite = new Set<string>();
  for (const p of pendingItems) {
    if (seenPendingIds.has(p.pendingId)) {
      return fail(1, 'DUPLICATE_PENDING_ID', `pendingId duplicado: ${p.pendingId}.`);
    }
    seenPendingIds.add(p.pendingId);

    if (!mainById.has(p.transactionId)) {
      return fail(
        1,
        'PENDING_REFERENCES_NON_MAIN_TX',
        `Pendência ${p.pendingId} referencia transação fora das principais do mês (${p.transactionId}).`
      );
    }
    const composite = `${p.transactionId}:${p.pendingType}`;
    if (seenPendingComposite.has(composite)) {
      return fail(1, 'DUPLICATE_PENDING_FOR_TX', `Pendência duplicada (${p.pendingType}) para ${p.transactionId}.`);
    }
    seenPendingComposite.add(composite);

    if (p.status === 'JUSTIFICADA' && p.justification.trim().length < 3) {
      return fail(1, 'PENDING_JUSTIFICATION_TOO_SHORT', `Pendência JUSTIFICADA sem justificativa válida (${p.pendingId}).`);
    }
  }

  // Recalculate summary & categoryTotals exclusively from main transactions
  const calcAccounts = new Map<string, CashAccount>();
  const calcCategories = new Map<string, CategoryTotal>();
  let calcRevenue = 0;
  let calcExpense = 0;
  let txTotalInflow = 0;
  let txTotalOutflow = 0;

  for (const tx of transactions) {
    let acc = calcAccounts.get(tx.accountId);
    if (!acc) {
      acc = {
        accountId: tx.accountId,
        accountName: tx.accountName,
        accountType: tx.accountType,
        inflowCents: 0,
        outflowCents: 0,
        netCents: 0,
      };
      calcAccounts.set(tx.accountId, acc);
    }
    let cat = calcCategories.get(tx.categoryOriginal);
    if (!cat) {
      cat = {
        category: tx.categoryOriginal,
        inflowCents: 0,
        outflowCents: 0,
        netCents: 0,
      };
      calcCategories.set(tx.categoryOriginal, cat);
    }

    if (tx.direction === 'ENTRADA') {
      acc.inflowCents += tx.amountCents;
      cat.inflowCents += tx.amountCents;
      txTotalInflow += tx.amountCents;
    } else {
      acc.outflowCents += tx.amountCents;
      cat.outflowCents += tx.amountCents;
      txTotalOutflow += tx.amountCents;
    }
    acc.netCents = acc.inflowCents - acc.outflowCents;
    cat.netCents = cat.inflowCents - cat.outflowCents;

    if (tx.direction === 'ENTRADA' && tx.classification === 'RECEITA' && tx.accountType === 'PJ') {
      calcRevenue += tx.amountCents;
    }
    if (
      tx.direction === 'SAIDA' &&
      tx.classification === 'DESPESA' &&
      (tx.accountType === 'PJ' || tx.isPfBusinessExpense)
    ) {
      calcExpense += tx.amountCents;
    }
  }

  let calcSettled = 0;
  for (const link of reimbursementLinks) {
    if (mainById.has(link.pjReimbursementTransactionId)) {
      calcSettled += link.amountCents;
    }
  }

  const calcPendingCount = pendingItems.filter((p) => p.status === 'PENDENTE').length;
  const calcJustifiedCount = pendingItems.filter((p) => p.status === 'JUSTIFICADA').length;

  // Check cashFlowByAccount order, uniqueness, and values
  const expectedAccounts = [...calcAccounts.values()].sort((a, b) => compareUtf8Bytes(a.accountId, b.accountId));
  if (summary.cashFlowByAccount.length !== expectedAccounts.length) {
    return fail(1, 'SUMMARY_ACCOUNTS_COUNT_MISMATCH', 'Quantidade de contas em summary.cashFlowByAccount divergente.');
  }
  let accSumInflow = 0;
  let accSumOutflow = 0;
  let accSumNet = 0;
  for (let i = 0; i < expectedAccounts.length; i++) {
    const actual = summary.cashFlowByAccount[i]!;
    const expected = expectedAccounts[i]!;
    if (i > 0 && compareUtf8Bytes(summary.cashFlowByAccount[i - 1]!.accountId, actual.accountId) >= 0) {
      return fail(1, 'SUMMARY_ACCOUNTS_ORDER_INVALID', `Ordem ou duplicidade inválida em cashFlowByAccount (${actual.accountId}).`);
    }
    if (actual.netCents !== actual.inflowCents - actual.outflowCents) {
      return fail(1, 'SUMMARY_ACCOUNT_NET_MISMATCH', `netCents inconsistente para conta ${actual.accountId}.`);
    }
    if (
      actual.accountId !== expected.accountId ||
      actual.accountName !== expected.accountName ||
      actual.accountType !== expected.accountType ||
      actual.inflowCents !== expected.inflowCents ||
      actual.outflowCents !== expected.outflowCents ||
      actual.netCents !== expected.netCents
    ) {
      return fail(1, 'SUMMARY_ACCOUNT_TOTALS_MISMATCH', `Totais divergentes em cashFlowByAccount para conta ${actual.accountId}.`);
    }
    accSumInflow += actual.inflowCents;
    accSumOutflow += actual.outflowCents;
    accSumNet += actual.netCents;
  }

  // Check categoryTotals order, uniqueness, completeness, and values (verifier-acceptance.md rules 1..9)
  const expectedCategories = [...calcCategories.values()].sort((a, b) => compareUtf8Bytes(a.category, b.category));
  const seenCategories = new Set<string>();
  for (let i = 0; i < summary.categoryTotals.length; i++) {
    const item = summary.categoryTotals[i]!;
    if (
      item.category !== item.category.normalize('NFC') ||
      item.category !== item.category.trim() ||
      item.category.length === 0
    ) {
      return fail(1, 'CATEGORY_TOTAL_NOT_NORMALIZED', `Categoria não normalizada em categoryTotals: ${item.category}.`);
    }
    if (seenCategories.has(item.category)) {
      return fail(1, 'CATEGORY_TOTAL_DUPLICATE', `Categoria duplicada em categoryTotals: ${item.category}.`);
    }
    seenCategories.add(item.category);
    if (i > 0 && compareUtf8Bytes(summary.categoryTotals[i - 1]!.category, item.category) >= 0) {
      return fail(1, 'CATEGORY_TOTAL_ORDER_INVALID', `Ordem UTF-8 inválida em categoryTotals na categoria ${item.category}.`);
    }
    if (item.netCents !== item.inflowCents - item.outflowCents) {
      return fail(1, 'CATEGORY_TOTAL_NET_MISMATCH', `Saldo líquido inconsistente na categoria ${item.category}.`);
    }
  }

  if (summary.categoryTotals.length !== expectedCategories.length) {
    return fail(1, 'CATEGORY_TOTAL_SET_MISMATCH', 'Conjunto de categorias em categoryTotals diverge das transações principais.');
  }

  let catSumInflow = 0;
  let catSumOutflow = 0;
  let catSumNet = 0;
  for (let i = 0; i < expectedCategories.length; i++) {
    const actual = summary.categoryTotals[i]!;
    const expected = expectedCategories[i]!;
    if (
      actual.category !== expected.category ||
      actual.inflowCents !== expected.inflowCents ||
      actual.outflowCents !== expected.outflowCents ||
      actual.netCents !== expected.netCents
    ) {
      return fail(1, 'CATEGORY_TOTAL_VALUE_MISMATCH', `Totais divergentes para a categoria ${actual.category}.`);
    }
    catSumInflow += actual.inflowCents;
    catSumOutflow += actual.outflowCents;
    catSumNet += actual.netCents;
  }

  // Reconcile category sums with main transactions and cashFlowByAccount
  const txTotalNet = txTotalInflow - txTotalOutflow;
  if (
    catSumInflow !== txTotalInflow ||
    catSumOutflow !== txTotalOutflow ||
    catSumNet !== txTotalNet ||
    catSumInflow !== accSumInflow ||
    catSumOutflow !== accSumOutflow ||
    catSumNet !== accSumNet
  ) {
    return fail(1, 'CATEGORY_ACCOUNT_RECONCILIATION_MISMATCH', 'Soma de categoryTotals não reconcilia com transações e contas.');
  }

  if (summary.businessRevenueTotalCents !== calcRevenue) {
    return fail(1, 'SUMMARY_REVENUE_MISMATCH', 'summary.businessRevenueTotalCents divergente.');
  }
  if (summary.businessExpenseTotalCents !== calcExpense) {
    return fail(1, 'SUMMARY_EXPENSE_MISMATCH', 'summary.businessExpenseTotalCents divergente.');
  }
  if (summary.reimbursementsSettledInPeriodCents !== calcSettled) {
    return fail(1, 'SUMMARY_SETTLED_MISMATCH', 'summary.reimbursementsSettledInPeriodCents divergente.');
  }
  if (summary.pendingCount !== calcPendingCount) {
    return fail(1, 'SUMMARY_PENDING_COUNT_MISMATCH', 'summary.pendingCount divergente.');
  }
  if (summary.justifiedCount !== calcJustifiedCount) {
    return fail(1, 'SUMMARY_JUSTIFIED_COUNT_MISMATCH', 'summary.justifiedCount divergente.');
  }

  return null;
}

const guardedCsvCell = (value: string) => (/^ *[=+\-@\t\r\n]/.test(value) ? `'${value}` : value);
const formatCsvCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
const CSV_HEADER = [
  'transaction_id',
  'account_id',
  'account_name',
  'account_type',
  'occurred_on',
  'direction',
  'amount_cents',
  'description',
  'category',
  'classification',
  'is_pf_business_expense',
  'explanation',
  'document_ids',
];

function buildExpectedCsvString(transactions: readonly ManifestTransaction[]): string {
  const rows = transactions.map((t) => [
    t.transactionId,
    t.accountId,
    guardedCsvCell(t.accountName),
    t.accountType,
    t.occurredOn,
    t.direction,
    String(t.amountCents),
    guardedCsvCell(t.descriptionOriginal),
    guardedCsvCell(t.categoryOriginal),
    t.classification,
    String(t.isPfBusinessExpense),
    guardedCsvCell(t.explanationOriginal),
    t.documentIds.join(';'),
  ]);
  return [CSV_HEADER, ...rows].map((row) => row.map(formatCsvCell).join(',')).join('\r\n') + '\r\n';
}

function hasValidAttachmentSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'application/pdf') {
    return bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  }
  if (mimeType === 'image/png') {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(sig);
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return false;
}

async function collectPackageFiles(
  rootDir: string,
  currentDir: string,
  foundFiles: Map<string, { fullPath: string; size: number }>
): Promise<VerificationResult | null> {
  const entries = await readdir(currentDir);
  for (const name of entries) {
    const fullPath = join(currentDir, name);
    const st = await lstat(fullPath);
    const relPath = relative(rootDir, fullPath).split(sep).join('/');
    if (st.isSymbolicLink()) {
      return fail(1, 'SYMLINK_FORBIDDEN', `Link simbólico proibido no pacote: ${relPath}.`);
    }
    if (st.isDirectory()) {
      const subErr = await collectPackageFiles(rootDir, fullPath, foundFiles);
      if (subErr) return subErr;
    } else if (st.isFile()) {
      foundFiles.set(relPath, { fullPath, size: st.size });
    } else {
      return fail(1, 'SPECIAL_FILE_FORBIDDEN', `Entrada especial não permitida no pacote: ${relPath}.`);
    }
  }
  return null;
}

export async function verifyDeliveryPackage(
  packageDirInput: string,
  referenceManifestInput: string
): Promise<VerificationResult> {
  if (!packageDirInput?.trim() || !referenceManifestInput?.trim()) {
    return fail(2, 'INVALID_ARGUMENTS', 'Informe o diretório extraído e o caminho externo do manifesto de referência.');
  }

  const pkgDirResolved = resolve(packageDirInput);
  const refPathResolved = resolve(referenceManifestInput);

  let pkgStat;
  try {
    pkgStat = await lstat(pkgDirResolved);
  } catch {
    return fail(2, 'PACKAGE_DIR_NOT_FOUND', 'Diretório do pacote não encontrado.');
  }
  if (pkgStat.isSymbolicLink() || !pkgStat.isDirectory()) {
    return fail(2, 'INVALID_PACKAGE_DIR', 'O caminho do pacote deve ser um diretório real (não link simbólico).');
  }

  let refStat;
  try {
    refStat = await lstat(refPathResolved);
  } catch {
    return fail(2, 'REFERENCE_MANIFEST_NOT_FOUND', 'Manifesto de referência não encontrado.');
  }
  if (refStat.isSymbolicLink() || !refStat.isFile()) {
    return fail(2, 'INVALID_REFERENCE_MANIFEST', 'O manifesto de referência deve ser um arquivo regular.');
  }

  const realPkgDir = await realpath(pkgDirResolved);
  const realRefPath = await realpath(refPathResolved);
  const relFromPkg = relative(realPkgDir, realRefPath);
  if (relFromPkg === '' || (!relFromPkg.startsWith('..') && !isAbsolute(relFromPkg))) {
    return fail(
      2,
      'EXTERNAL_REFERENCE_REQUIRED',
      'O manifesto de referência deve ser externo ao diretório extraído do pacote.'
    );
  }

  if (refStat.size === 0 || refStat.size > MANIFEST_LIMIT_BYTES) {
    return fail(1, 'MANIFEST_SIZE_INVALID', 'Tamanho do manifesto de referência inválido ou acima de 8 MiB.');
  }

  const pkgManifestPath = join(realPkgDir, 'manifesto.json');
  let pkgManifestStat;
  try {
    pkgManifestStat = await lstat(pkgManifestPath);
  } catch {
    return fail(1, 'MANIFEST_MISSING', 'manifesto.json ausente na raiz do diretório extraído.');
  }
  if (pkgManifestStat.isSymbolicLink()) {
    return fail(1, 'SYMLINK_FORBIDDEN', 'manifesto.json não pode ser link simbólico.');
  }
  if (!pkgManifestStat.isFile() || pkgManifestStat.size === 0 || pkgManifestStat.size > MANIFEST_LIMIT_BYTES) {
    return fail(1, 'MANIFEST_SIZE_INVALID', 'manifesto.json inválido ou acima de 8 MiB.');
  }

  const [refBytes, pkgManifestBytes] = await Promise.all([
    readFile(realRefPath),
    readFile(pkgManifestPath),
  ]);

  if (!refBytes.equals(pkgManifestBytes)) {
    return fail(1, 'MANIFEST_BYTES_MISMATCH', 'manifesto.json do pacote diverge em bytes do manifesto de referência externo.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(refBytes.toString('utf8'));
  } catch {
    return fail(1, 'MANIFEST_INVALID_JSON', 'Manifesto não contém JSON UTF-8 válido.');
  }

  const schemaErr = validateManifestSchema(parsed);
  if (schemaErr) return schemaErr;

  const manifest = parsed as ManifestV2;
  const semanticErr = validateSemanticsAndRelations(manifest);
  if (semanticErr) return semanticErr;

  // Walk directory tree and verify files
  const foundFiles = new Map<string, { fullPath: string; size: number }>();
  const walkErr = await collectPackageFiles(realPkgDir, realPkgDir, foundFiles);
  if (walkErr) return walkErr;

  const expectedByPath = new Map<string, ManifestFile>();
  for (const f of manifest.files) {
    expectedByPath.set(f.path, f);
  }

  for (const [relPath] of foundFiles) {
    if (relPath === 'manifesto.json') continue;
    if (!expectedByPath.has(relPath)) {
      return fail(1, 'EXTRA_FILE', `Arquivo extra não descrito no manifesto: ${relPath}.`);
    }
  }

  for (const [relPath, fileSpec] of expectedByPath) {
    const onDisk = foundFiles.get(relPath);
    if (!onDisk) {
      return fail(1, 'MISSING_FILE', `Arquivo descrito no manifesto está ausente: ${relPath}.`);
    }
    if (onDisk.size !== fileSpec.sizeBytes) {
      return fail(1, 'FILE_SIZE_MISMATCH', `Tamanho divergente para ${relPath}.`);
    }
    const bytes = await readFile(onDisk.fullPath);
    if (bytes.length !== fileSpec.sizeBytes) {
      return fail(1, 'FILE_SIZE_MISMATCH', `Tamanho lido divergente para ${relPath}.`);
    }
    const actualHash = sha256Hex(bytes);
    if (actualHash !== fileSpec.sha256) {
      return fail(1, 'FILE_HASH_MISMATCH', `Hash SHA-256 divergente para ${relPath}.`);
    }

    if (fileSpec.role === 'ANEXO_DOCUMENTO') {
      if (!hasValidAttachmentSignature(bytes, fileSpec.mimeType)) {
        return fail(1, 'ATTACHMENT_SIGNATURE_INVALID', `Assinatura binária inválida para ${relPath}.`);
      }
    } else if (fileSpec.role === 'RESUMO_HTML') {
      const htmlText = bytes.toString('utf8');
      if (/<script\b|<form\b|<iframe\b|<object\b|https?:\/\//i.test(htmlText)) {
        return fail(1, 'ACTIVE_HTML_CONTENT', 'resumo.html contém script, formulário ou recurso remoto proibido.');
      }
    } else if (fileSpec.role === 'PLANILHA_CSV') {
      const csvText = bytes.toString('utf8').replace(/\r\n/g, '\n');
      const expectedCsv = buildExpectedCsvString(manifest.transactions).replace(/\r\n/g, '\n');
      if (csvText !== expectedCsv) {
        return fail(1, 'CSV_CONTENT_INVALID', 'movimentacoes.csv diverge das movimentações principais ou omite proteção de fórmula.');
      }
    }
  }

  return {
    ok: true,
    exitCode: 0,
    code: 'VERIFIED',
    message: `Pacote verificado com sucesso perante a referência (${manifest.delivery.periodMonth} v${manifest.delivery.versionNumber}).`,
    summary: manifest.summary,
    counts: {
      mainTransactions: manifest.transactions.length,
      contextTransactions: manifest.contextTransactions.length,
      attachments: manifest.files.filter((f) => f.role === 'ANEXO_DOCUMENTO').length,
    },
  };
}
