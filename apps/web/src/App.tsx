import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  allowedClassifications,
  allowedPendingActions,
  attemptLogout,
  buildTransactionPatch,
  buildVerifierCommand,
  canMarkPfBusinessExpense,
  defaultDateForMonth,
  describeApiError,
  describeDocumentError,
  describeImportError,
  describePendingError,
  documentsByTransaction,
  formatBrlCents,
  formatFileSize,
  generateIdempotencyKey,
  hasQuestion,
  isValidPeriodMonth,
  linkableDocuments,
  importReady,
  importReasonLabel,
  importStatusLabel,
  lockedFieldsForLinked,
  nextVersionRequiresReason,
  nextMonthAction,
  parseBrlCents,
  reimbursementStatusLabel,
  roleInPeriodLabel,
  compatibleInflows,
  shiftPeriodMonth,
  validateDocumentFile,
  validateImportFile,
  validatePendingText,
} from './ledger.mjs';
import type { AccountType, Classification, Direction, ImportTotals, PendingAction } from './ledger.mjs';

interface SessionContext {
  userId: string;
  displayName: string;
  workspace: { workspaceId: string; companyName: string; currency: 'BRL' };
  revision: number;
  csrfToken: string;
}

interface AccountItem {
  id: string;
  name: string;
  accountType: AccountType;
  active: boolean;
}

interface PreviewTransaction {
  transactionId: string;
  accountId: string;
  accountName: string;
  accountType: AccountType;
  occurredOn: string;
  direction: Direction;
  amountCents: number;
  descriptionOriginal: string;
  categoryOriginal: string;
  classification: Classification;
  isPfBusinessExpense: boolean;
  explanationOriginal: string;
  sourceType: 'MANUAL' | 'CSV';
  sourceCode: string;
  externalId: string;
  documentIds: string[];
  reimbursementStatus: ReimbursementStatus;
}

type ReimbursementStatus = 'NAO_APLICAVEL' | 'PENDENTE_REEMBOLSO' | 'REEMBOLSADA_NO_MES' | 'REEMBOLSADA_OUTRO_MES' | 'LIQUIDACAO_DE_REEMBOLSO';

interface ReimbursementLink {
  reimbursementLinkId: string;
  pfExpenseTransactionId: string;
  pjReimbursementTransactionId: string;
  pfInflowTransactionId: string | null;
  amountCents: number;
  pfOriginDocumentIds: string[];
  roleInPeriod: 'DESPESA_ORIGEM_NO_PERIODO' | 'REEMBOLSO_PJ_NO_PERIODO' | 'AMBOS_NO_PERIODO' | 'ENTRADA_PF_NO_PERIODO';
}

interface ReimbursementCandidate {
  transactionId: string;
  accountId: string;
  accountName: string;
  occurredOn: string;
  amountCents: number;
  descriptionOriginal: string;
  categoryOriginal: string;
}

interface ReimbursementCandidates {
  pfExpense: ReimbursementCandidate;
  pjOutflows: ReimbursementCandidate[];
  pfInflows: ReimbursementCandidate[];
}

type ReimbursementPanelState = { kind: 'link'; pfExpenseId: string } | { kind: 'unlink'; linkId: string };

const MAX_REIMBURSEMENT_NOTES = 2000;

type TransactionPanelState = { kind: 'edit' | 'delete'; transactionId: string };

interface TransactionDraft {
  accountId: string;
  occurredOn: string;
  direction: Direction;
  amountInput: string;
  description: string;
  category: string;
  classification: Classification;
  isPfBusinessExpense: boolean;
  explanation: string;
}

type PendingPanelState =
  | { kind: 'create'; transactionId: string }
  | { kind: 'manage' | 'justify' | 'edit' | 'resolve' | 'reopen'; pendingId: string };

interface PeriodDocument {
  documentId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  supersedesDocumentId: string | null;
  transactionIds: string[];
}

type DocumentPanelState =
  | { kind: 'replace' | 'unlink'; transactionId: string; documentId: string }
  | { kind: 'link'; transactionId: string };

interface ImportPreviewRow {
  line: number;
  externalId: string | null;
  status: string;
  code: string | null;
  message: string | null;
}

interface ImportPreviewResult {
  fileHash: string;
  revision: number;
  accountId: string;
  sourceCode: string;
  periodMonth: string;
  sourceCodeKnown: boolean;
  totals: ImportTotals;
  rows: ImportPreviewRow[];
}

const IMPORT_TOTAL_LABELS: [keyof ImportTotals, string][] = [['new', 'Novas'], ['ignored', 'Já importadas'], ['repeated', 'Repetidas'], ['conflicting', 'Conflitos'], ['invalid', 'Inválidas']];

function isImportPreviewResult(value: unknown): value is ImportPreviewResult {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<ImportPreviewResult>;
  return typeof item.fileHash === 'string' && Number.isSafeInteger(item.revision) && typeof item.totals === 'object' && item.totals !== null && Array.isArray(item.rows);
}

function isImportConfirmation(value: unknown): value is { revision: number; transactionIds: string[] } {
  if (!isRevisionResult(value)) return false;
  return Array.isArray((value as { transactionIds?: unknown }).transactionIds);
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = { 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG' };

const JUSTIFICATION_DISCLAIMER = 'A justificativa é uma declaração sua. Ela não resolve a pendência nem valida o lançamento fiscalmente.';
const AUTOMATIC_PENDING_GUIDANCE = 'Resolva eliminando a causa (anexar comprovante, vincular reembolso ou corrigir o lançamento).';
const PENDING_ACTION_LABELS: Record<PendingAction, string> = { JUSTIFY: 'Justificar', EDIT: 'Editar texto', RESOLVE: 'Resolver', REOPEN: 'Reabrir' };
const PENDING_ACTION_PANEL: Record<PendingAction, 'justify' | 'edit' | 'resolve' | 'reopen'> = { JUSTIFY: 'justify', EDIT: 'edit', RESOLVE: 'resolve', REOPEN: 'reopen' };
const PENDING_PANEL_ACTION: Record<'justify' | 'edit' | 'resolve' | 'reopen', PendingAction> = { justify: 'JUSTIFY', edit: 'EDIT', resolve: 'RESOLVE', reopen: 'REOPEN' };
const PENDING_STATUS_LABELS: Record<PreviewPending['status'], string> = { PENDENTE: 'Aberta', JUSTIFICADA: 'Justificada', RESOLVIDA: 'Resolvida' };

const LINKED_TRANSACTION_GUIDANCE = 'Este lançamento participa de um reembolso. Desfaça o vínculo para mudar valor, data, conta, direção, classificação ou marca empresarial.';

function draftFromTransaction(tx: PreviewTransaction): TransactionDraft {
  return {
    accountId: tx.accountId,
    occurredOn: tx.occurredOn,
    direction: tx.direction,
    amountInput: `${Math.floor(tx.amountCents / 100)},${String(tx.amountCents % 100).padStart(2, '0')}`,
    description: tx.descriptionOriginal,
    category: tx.categoryOriginal,
    classification: tx.classification,
    isPfBusinessExpense: tx.isPfBusinessExpense,
    explanation: tx.explanationOriginal,
  };
}

interface PreviewPending {
  pendingId: string;
  transactionId: string;
  pendingType: 'DOCUMENTO_AUSENTE' | 'CLASSIFICACAO_A_ESCLARECER' | 'REEMBOLSO_PF_PENDENTE' | 'DUVIDA_CADASTRADA';
  status: 'PENDENTE' | 'JUSTIFICADA' | 'RESOLVIDA';
  description: string;
  justification: string;
}

interface CashAccount {
  accountId: string;
  accountName: string;
  accountType: AccountType;
  inflowCents: number;
  outflowCents: number;
  netCents: number;
}

interface CategoryTotal {
  category: string;
  inflowCents: number;
  outflowCents: number;
  netCents: number;
}

interface PreviewData {
  workspace: { workspaceId: string; companyName: string; currency: 'BRL' };
  periodMonth: string;
  revision: number;
  summary: {
    cashFlowByAccount: CashAccount[];
    businessRevenueTotalCents: number;
    businessExpenseTotalCents: number;
    reimbursementsSettledInPeriodCents: number;
    pendingCount: number;
    justifiedCount: number;
    categoryTotals: CategoryTotal[];
  };
  transactions: PreviewTransaction[];
  contextTransactions: PreviewTransaction[];
  reimbursementLinks: ReimbursementLink[];
  pendingItems: PreviewPending[];
}

interface DeliveryOperation {
  id: string;
  snapshotId: string;
  periodMonth: string;
  versionNumber: number;
  capturedRevision: number;
  status: 'EM_FILA' | 'EM_PROCESSAMENTO' | 'PRONTA' | 'FALHA';
  attemptCount: number;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface StatusNotice {
  tone: 'ok' | 'warn' | 'err';
  title: string;
  detail: string;
  code?: string;
}

const CLASSIFICATION_LABELS: Record<Classification, string> = {
  RECEITA: 'Receita',
  DESPESA: 'Despesa',
  TRANSFERENCIA: 'Transferência',
  A_ESCLARECER: 'A esclarecer',
};

const PENDING_TYPE_LABELS: Record<PreviewPending['pendingType'], string> = {
  DOCUMENTO_AUSENTE: 'Comprovante ausente',
  CLASSIFICACAO_A_ESCLARECER: 'Classificação a esclarecer',
  REEMBOLSO_PF_PENDENTE: 'Reembolso PF pendente',
  DUVIDA_CADASTRADA: 'Dúvida cadastrada',
};

type WorkspaceSection = 'accounts' | 'transactions' | 'documents' | 'review' | 'deliveries';
const JOURNEY: { id: WorkspaceSection; label: string }[] = [
  { id: 'review', label: 'Visão do mês' },
  { id: 'accounts', label: 'Contas' },
  { id: 'transactions', label: 'Lançamentos' },
  { id: 'documents', label: 'Comprovantes' },
  { id: 'deliveries', label: 'Entregas' },
];

function Icon({ name }: { name: 'upload' | 'arrow' | 'check' }) {
  const paths = {
    upload: <><path d="M12 16V3m0 0L7 8m5-5 5 5" /><path d="M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></>,
    arrow: <><path d="M4 12h16m0 0-6-6m6 6-6 6" /></>,
    check: <><path d="m4 12 5 5L20 6" /></>,
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function isReimbursementCandidates(value: unknown): value is ReimbursementCandidates {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ReimbursementCandidates>;
  return typeof candidate.pfExpense === 'object' && candidate.pfExpense !== null
    && Array.isArray(candidate.pjOutflows) && Array.isArray(candidate.pfInflows);
}

function isRevisionResult(value: unknown): value is { revision: number } {
  return typeof value === 'object' && value !== null && Number.isSafeInteger((value as { revision?: unknown }).revision);
}

async function fetchAllPages<T>(url: string, limit: number): Promise<{ items: T[]; status: number }> {
  const items: T[] = [];
  const visited = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`${url}?${query}`, { credentials: 'same-origin' });
    if (!response.ok) return { items: [], status: response.status };
    const page = (await response.json()) as { items: T[]; nextCursor: string | null };
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor) {
      if (visited.has(cursor)) throw new Error('Cursor de paginação repetido');
      visited.add(cursor);
    }
  } while (cursor);
  return { items, status: 200 };
}

export function App() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<SessionContext | null>(null);
  const [notice, setNotice] = useState<StatusNotice | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [dataStatus, setDataStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('review');
  const [fileError, setFileError] = useState<string | null>(null);
  const [draggingFile, setDraggingFile] = useState(false);
  const [copiedOperationId, setCopiedOperationId] = useState<string | null>(null);
  const [showOlderDeliveries, setShowOlderDeliveries] = useState(false);
  const uploadSectionRef = useRef<HTMLElement | null>(null);
  const pendingSectionRef = useRef<HTMLElement | null>(null);
  const loadSequence = useRef(0);
  const operationContext = useRef(0);

  // Login form
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Period selection
  const [periodMonth, setPeriodMonth] = useState('2026-10');
  const [monthDraft, setMonthDraft] = useState('2026-10');

  // Loaded domain data
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryOperation[]>([]);
  const [activeOperation, setActiveOperation] = useState<DeliveryOperation | null>(null);

  // Account creation form
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountType, setNewAccountType] = useState<AccountType>('PF');

  // Manual transaction form
  const [txAccountId, setTxAccountId] = useState('');
  const [txDate, setTxDate] = useState('2026-10-15');
  const [txDirection, setTxDirection] = useState<Direction>('SAIDA');
  const [txAmountInput, setTxAmountInput] = useState('12,50');
  const [txClassification, setTxClassification] = useState<Classification>('DESPESA');
  const [txCategory, setTxCategory] = useState('Geral');
  const [txDescription, setTxDescription] = useState('');
  const [txPfBusiness, setTxPfBusiness] = useState(false);
  const [txExplanation, setTxExplanation] = useState('');

  // Document upload form
  const [docTransactionId, setDocTransactionId] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [lastUploadedDoc, setLastUploadedDoc] = useState<{
    documentId: string;
    transactionId: string;
    sha256: string;
    sizeBytes: number;
  } | null>(null);

  // Reimbursement panel
  const [reimbPanel, setReimbPanel] = useState<ReimbursementPanelState | null>(null);
  const [reimbCandidates, setReimbCandidates] = useState<ReimbursementCandidates | null>(null);
  const [reimbLoading, setReimbLoading] = useState(false);
  const [reimbError, setReimbError] = useState<string | null>(null);
  const [reimbOutflowId, setReimbOutflowId] = useState('');
  const [reimbInflowId, setReimbInflowId] = useState('');
  const [reimbNotes, setReimbNotes] = useState('');
  const reimbSequence = useRef(0);
  const reimbPanelRef = useRef<HTMLElement | null>(null);
  const reimbTriggerRef = useRef<HTMLElement | null>(null);
  const [reimbRevision, setReimbRevision] = useState<number | null>(null);

  // Transaction correction/deletion panel
  const [txPanel, setTxPanel] = useState<TransactionPanelState | null>(null);
  const [txDraft, setTxDraft] = useState<TransactionDraft | null>(null);
  const [txPanelRevision, setTxPanelRevision] = useState<number | null>(null);
  const [txPanelMessage, setTxPanelMessage] = useState<{ tone: 'warn' | 'err'; text: string } | null>(null);
  const txPanelSequence = useRef(0);
  const txPanelRef = useRef<HTMLElement | null>(null);
  const txPanelTriggerRef = useRef<HTMLElement | null>(null);

  // Pending cycle panel
  const [pendingPanel, setPendingPanel] = useState<PendingPanelState | null>(null);
  const [pendingText, setPendingText] = useState('');
  const [pendingPanelRevision, setPendingPanelRevision] = useState<number | null>(null);
  const [pendingPanelMessage, setPendingPanelMessage] = useState<{ tone: 'warn' | 'err'; text: string } | null>(null);
  const pendingPanelSequence = useRef(0);
  const pendingPanelRef = useRef<HTMLElement | null>(null);
  const pendingPanelTriggerRef = useRef<HTMLElement | null>(null);

  const [documents, setDocuments] = useState<PeriodDocument[]>([]);
  const [documentPanel, setDocumentPanel] = useState<DocumentPanelState | null>(null);
  const [documentPanelRevision, setDocumentPanelRevision] = useState<number | null>(null);
  const [documentPanelMessage, setDocumentPanelMessage] = useState<string | null>(null);
  const [documentPanelFile, setDocumentPanelFile] = useState<File | null>(null);
  const [documentPanelFileError, setDocumentPanelFileError] = useState<string | null>(null);
  const [documentLinkId, setDocumentLinkId] = useState('');
  const documentPanelSequence = useRef(0);
  const documentPanelRef = useRef<HTMLElement | null>(null);
  const documentPanelTriggerRef = useRef<HTMLElement | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  const [importAccountId, setImportAccountId] = useState('');
  const [importSource, setImportSource] = useState('');
  const [importMonth, setImportMonth] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importFileError, setImportFileError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportPreviewResult | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const importSequence = useRef(0);
  const importPanelRef = useRef<HTMLElement | null>(null);
  const importTriggerRef = useRef<HTMLElement | null>(null);

  // Delivery capture form
  const [idempotencyKey, setIdempotencyKey] = useState(() => generateIdempotencyKey());
  const [rectificationReason, setRectificationReason] = useState('');

  const loadWorkspaceData = useCallback(async (month: string, activeSession?: SessionContext | null) => {
    const currentSession = activeSession ?? session;
    if (!currentSession) return;
    const sequence = ++loadSequence.current;
    setDataStatus('loading');

    let accPage: { items: AccountItem[]; status: number };
    let prevRes: Response;
    let delPage: { items: DeliveryOperation[]; status: number };
    let docsRes: Response;
    try {
      [accPage, prevRes, delPage, docsRes] = await Promise.all([
        fetchAllPages<AccountItem>('/api/v1/accounts', 200),
        fetch(`/api/v1/periods/${encodeURIComponent(month)}/preview`, { credentials: 'same-origin' }),
        fetchAllPages<DeliveryOperation>(`/api/v1/periods/${encodeURIComponent(month)}/deliveries`, 200),
        fetch(`/api/v1/documents?periodMonth=${encodeURIComponent(month)}`, { credentials: 'same-origin' }),
      ]);
    } catch {
      if (sequence === loadSequence.current) {
        setDataStatus('error');
        setNotice({ tone: 'err', title: 'Falha de conexão', detail: 'Não foi possível atualizar o caderno. Tente novamente.' });
      }
      return;
    }
    if (sequence !== loadSequence.current) return;

    if (accPage.status === 401 || prevRes.status === 401 || delPage.status === 401 || docsRes.status === 401) {
      closeReimbursementPanel();
      closeTransactionPanel();
      closePendingPanel();
      closeDocumentPanel();
      closeImportPanel();
      setSession(null);
      setDataStatus('loading');
      setNotice({
        tone: 'warn',
        title: 'Sessão encerrada ou expirada',
        detail: 'Autentique-se novamente para continuar operando o fechamento mensal.',
      });
      return;
    }

    if (accPage.status === 200) {
      setAccounts(accPage.items);
      if (accPage.items.length > 0) {
        setTxAccountId((prev) => (accPage.items.some((a) => a.id === prev) ? prev : accPage.items[0]!.id));
      }
    }

    if (prevRes.ok) {
      let prevJson: PreviewData;
      try {
        prevJson = (await prevRes.json()) as PreviewData;
      } catch {
        if (sequence === loadSequence.current) {
          setDataStatus('error');
          setNotice({ tone: 'err', title: 'Prévia indisponível', detail: 'Não foi possível ler os dados do mês. Atualize a visão.' });
        }
        return;
      }
      if (sequence !== loadSequence.current) return;
      setPreview(prevJson);
      setSession((prev) => (prev ? { ...prev, revision: prevJson.revision } : prev));
      if (prevJson.transactions.length > 0) {
        setDocTransactionId((prev) =>
          prevJson.transactions.some((t) => t.transactionId === prev)
            ? prev
            : prevJson.transactions[0]!.transactionId
        );
      } else {
        setDocTransactionId('');
      }
    }

    let documentsLoaded = false;
    if (docsRes.ok) {
      const docsJson = await docsRes.json().catch(() => null) as { documents?: unknown } | null;
      if (sequence !== loadSequence.current) return;
      if (docsJson && Array.isArray(docsJson.documents)) {
        setDocuments(docsJson.documents as PeriodDocument[]);
        documentsLoaded = true;
      }
    }

    if (delPage.status === 200) {
      setDeliveries(delPage.items);
      const latest = delPage.items[delPage.items.length - 1] ?? null;
      setActiveOperation(latest);
    }
    if (accPage.status !== 200 || !prevRes.ok || delPage.status !== 200 || !documentsLoaded) {
      setDataStatus('error');
      setNotice({ tone: 'err', title: 'Visão incompleta', detail: 'Uma parte do caderno não carregou. Atualize a visão antes de registrar novas alterações.' });
    } else {
      setDataStatus('ready');
    }
  }, [session]);

  // Initial session hydration
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v1/session', { credentials: 'same-origin' });
        if (!cancelled && res.ok) {
          const ctx = (await res.json()) as SessionContext;
          if (cancelled) return;
          setSession(ctx);
          await loadWorkspaceData(periodMonth, ctx);
        }
      } catch {
        // Unauthenticated or offline on initial load
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!session) {
      closeReimbursementPanel();
      closeTransactionPanel();
      closePendingPanel();
      closeDocumentPanel();
      closeImportPanel();
    }
  }, [session]);

  useEffect(() => {
    if (txPanel && txPanelRevision !== null && preview && preview.revision !== txPanelRevision) {
      closeTransactionPanel(true);
      setNotice((current) => current ?? { tone: 'warn', title: 'Visão atualizada', detail: 'O caderno mudou enquanto o painel do lançamento estava aberto. Reabra o lançamento para conferir os dados atuais.' });
    }
  }, [preview?.revision, txPanel, txPanelRevision]);

  useEffect(() => {
    if (pendingPanel && pendingPanelRevision !== null && preview && preview.revision !== pendingPanelRevision) {
      closePendingPanel(true);
      setNotice((current) => current ?? { tone: 'warn', title: 'Visão atualizada', detail: 'O caderno mudou enquanto o painel de pendência estava aberto. Reabra a pendência para conferir os dados atuais.' });
    }
  }, [preview?.revision, pendingPanel, pendingPanelRevision]);

  useEffect(() => {
    if (documentPanel && documentPanelRevision !== null && preview && preview.revision !== documentPanelRevision) {
      closeDocumentPanel(true);
      setNotice((current) => current ?? { tone: 'warn', title: 'Visão atualizada', detail: 'O caderno mudou enquanto o painel de documentos estava aberto. Reabra a ação para conferir os dados atuais.' });
    }
  }, [preview?.revision, documentPanel, documentPanelRevision]);

  useEffect(() => {
    if (importResult && preview && preview.revision !== importResult.revision) {
      importSequence.current += 1;
      setImportResult(null);
      setImportMessage('O caderno mudou desde a pré-visualização. Pré-visualize novamente.');
    }
  }, [preview?.revision, importResult]);

  useEffect(() => {
    if (reimbPanel && reimbRevision !== null && preview && preview.revision !== reimbRevision) {
      closeReimbursementPanel(true);
      setNotice((current) => current ?? { tone: 'warn', title: 'Visão atualizada', detail: 'O caderno mudou enquanto o painel de reembolso estava aberto. Reabra o vínculo para reler os candidatos.' });
    }
  }, [preview?.revision, reimbPanel, reimbRevision]);

  // Poll active operation while EM_FILA or EM_PROCESSAMENTO
  useEffect(() => {
    if (!session || !activeOperation) return;
    if (activeOperation.status !== 'EM_FILA' && activeOperation.status !== 'EM_PROCESSAMENTO') return;
    let cancelled = false;
    let requestInFlight = false;
    const context = operationContext.current;

    const timer = window.setInterval(async () => {
      if (requestInFlight || cancelled) return;
      requestInFlight = true;
      try {
        const res = await fetch(`/api/v1/operations/${encodeURIComponent(activeOperation.id)}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const op = (await res.json()) as DeliveryOperation;
        if (cancelled || context !== operationContext.current || op.periodMonth !== periodMonth) return;
        setActiveOperation(op);
        setDeliveries((prev) => prev.map((item) => (item.id === op.id ? op : item)));
        if (op.status === 'PRONTA') {
          setNotice({
            tone: 'ok',
            title: `Entrega v${op.versionNumber} pronta para download`,
            detail: `Pacote imutável e manifesto v2 publicados para ${op.periodMonth} (revisão capturada #${op.capturedRevision}).`,
          });
        } else if (op.status === 'FALHA') {
          setNotice({
            tone: 'err',
            title: `Falha terminal na operação v${op.versionNumber}`,
            detail: `Código público: ${op.errorCode ?? 'FALHA'}. Gere nova chave idempotente para iniciar outra tentativa.`,
          });
        }
      } catch {
        // Ignore transient poll errors
      } finally {
        requestInFlight = false;
      }
    }, 1500);

    return () => { cancelled = true; window.clearInterval(timer); };
  }, [session, activeOperation, periodMonth]);

  // Synchronize transaction classification & PF business flag when direction/account changes
  const selectedAccount = accounts.find((a) => a.id === txAccountId);
  const validClassifications = allowedClassifications(txDirection);

  useEffect(() => {
    if (!validClassifications.includes(txClassification)) {
      setTxClassification(txDirection === 'ENTRADA' ? 'RECEITA' : 'DESPESA');
    }
  }, [txDirection, txClassification, validClassifications]);

  useEffect(() => {
    if (!canMarkPfBusinessExpense(selectedAccount?.accountType, txDirection, txClassification)) {
      setTxPfBusiness(false);
    }
  }, [selectedAccount?.accountType, txDirection, txClassification]);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setBusyAction('login');
    setNotice(null);
    try {
      const res = await fetch('/api/v1/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail.trim(), password: loginPassword }),
      });
      if (!res.ok) {
        const err = describeApiError(res.status, await res.json().catch(() => null));
        setNotice({ tone: 'err', title: 'Falha na autenticação', detail: err.message, code: err.code });
        return;
      }
      const ctx = (await res.json()) as SessionContext;
      setLoginPassword('');
      setSession(ctx);
      setNotice({
        tone: 'ok',
        title: `Sessão iniciada: ${ctx.workspace.companyName}`,
        detail: `Espaço carregado na revisão #${ctx.revision}.`,
      });
      await loadWorkspaceData(periodMonth, ctx);
    } catch {
      setNotice({
        tone: 'err',
        title: 'Serviço indisponível',
        detail: 'Não foi possível iniciar a sessão. Verifique sua conexão e tente novamente.',
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleLogout() {
    if (!session || busyAction !== null) return;
    loadSequence.current += 1;
    closeReimbursementPanel();
    closeTransactionPanel();
    closePendingPanel();
    closeDocumentPanel();
    closeImportPanel();
    setBusyAction('logout');
    const outcome = await attemptLogout(session.csrfToken);
    setBusyAction(null);
    if (!outcome.ended) {
      setNotice({ tone: 'err', title: 'Não foi possível encerrar a sessão', detail: 'Sua sessão pode continuar ativa. Verifique a conexão e tente novamente.' });
      return;
    }
    operationContext.current += 1;
    setSession(null);
    setDataStatus('loading');
    setAccounts([]);
    setPreview(null);
    setDocuments([]);
    setDeliveries([]);
    setShowOlderDeliveries(false);
    setActiveOperation(null);
    setSelectedFile(null);
    setNotice(outcome.confirmed
      ? { tone: 'ok', title: 'Sessão encerrada', detail: 'Você saiu do caderno mensal.' }
      : { tone: 'warn', title: 'Sessão expirada', detail: 'Entre novamente para continuar.' });
  }

  async function changeMonth(nextMonth: string) {
    if (busyAction !== null) return;
    if (!isValidPeriodMonth(nextMonth)) {
      setNotice({
        tone: 'warn',
        title: 'Competência inválida',
        detail: 'Informe o mês no formato YYYY-MM (entre 1900-01 e 9999-12).',
      });
      return;
    }
    operationContext.current += 1;
    closeReimbursementPanel();
    closeTransactionPanel();
    closePendingPanel();
    closeDocumentPanel();
    closeImportPanel();
    setPeriodMonth(nextMonth);
    setPreview(null);
    setDocuments([]);
    setDeliveries([]);
    setDocTransactionId('');
    setSelectedFile(null);
    setFileError(null);
    setMonthDraft(nextMonth);
    setTxDate((prev) => defaultDateForMonth(nextMonth, prev));
    setIdempotencyKey(generateIdempotencyKey());
    if (session) {
      setBusyAction('month');
      try {
        await loadWorkspaceData(nextMonth, session);
      } finally {
        setBusyAction(null);
      }
    }
  }

  async function handleCreateAccount(event: FormEvent) {
    event.preventDefault();
    if (!session || busyAction !== null || dataStatus !== 'ready') return;
    setBusyAction('account');
    setNotice(null);
    try {
      const res = await fetch('/api/v1/accounts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrfToken,
        },
        body: JSON.stringify({
          name: newAccountName,
          accountType: newAccountType,
          expectedRevision: session.revision,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = describeApiError(res.status, body);
        setNotice({ tone: 'err', title: 'Não foi possível criar a conta', detail: err.message, code: err.code });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      const created = body as { account: AccountItem; revision: number };
      setNewAccountName('');
      const updatedSession = { ...session, revision: created.revision };
      setSession(updatedSession);
      setTxAccountId(created.account.id);
      setNotice({
        tone: 'ok',
        title: `Conta ${created.account.accountType} registrada`,
        detail: `"${created.account.name}" adicionada ao espaço (revisão #${created.revision}).`,
      });
      await loadWorkspaceData(periodMonth, updatedSession);
    } catch {
      setNotice({ tone: 'err', title: 'Conexão interrompida', detail: 'Confira a revisão do caderno antes de repetir o cadastro da conta.' });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCreateTransaction(event: FormEvent) {
    event.preventDefault();
    if (!session || busyAction !== null || dataStatus !== 'ready') return;
    const amountCents = parseBrlCents(txAmountInput);
    if (amountCents === null) {
      setNotice({
        tone: 'warn',
        title: 'Valor em reais inválido',
        detail: 'Informe um valor positivo em reais com até 2 casas decimais (ex.: 12,50 ou 1250,00).',
      });
      return;
    }
    setBusyAction('transaction');
    setNotice(null);
    try {
      const res = await fetch('/api/v1/transactions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrfToken,
        },
        body: JSON.stringify({
          accountId: txAccountId,
          occurredOn: txDate,
          direction: txDirection,
          amountCents,
          description: txDescription,
          category: txCategory,
          classification: txClassification,
          isPfBusinessExpense: txPfBusiness,
          explanation: txExplanation,
          expectedRevision: session.revision,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = describeApiError(res.status, body);
        setNotice({ tone: 'err', title: 'Lançamento recusado', detail: err.message, code: err.code });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      const created = body as { transaction: PreviewTransaction; revision: number };
      const txMonth = created.transaction.occurredOn.slice(0, 7);
      const updatedSession = { ...session, revision: created.revision };
      setSession(updatedSession);
      setTxDescription('');
      setTxExplanation('');
      setDocTransactionId(created.transaction.transactionId);
      if (txMonth !== periodMonth) {
        setPeriodMonth(txMonth);
        setMonthDraft(txMonth);
      }
      setNotice({
        tone: 'ok',
        title: `Lançamento registrado (${formatBrlCents(created.transaction.amountCents)})`,
        detail: `Movimentação gravada em ${created.transaction.occurredOn} na revisão #${created.revision}.`,
      });
      await loadWorkspaceData(txMonth, updatedSession);
    } catch {
      setNotice({ tone: 'err', title: 'Conexão interrompida', detail: 'Confira a revisão e os lançamentos antes de registrar novamente.' });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleUploadDocument(event: FormEvent) {
    event.preventDefault();
    if (!session || busyAction !== null || dataStatus !== 'ready') return;
    if (!docTransactionId) {
      setNotice({
        tone: 'warn',
        title: 'Selecione uma movimentação',
        detail: 'Escolha o lançamento do mês que receberá o comprovante.',
      });
      return;
    }
    if (!selectedFile) {
      setNotice({
        tone: 'warn',
        title: 'Selecione um arquivo PDF, PNG ou JPEG',
        detail: 'O comprovante deve ter até 5 MiB.',
      });
      return;
    }
    const invalidFile = validateDocumentFile(selectedFile);
    if (invalidFile) {
      setFileError(invalidFile);
      return;
    }
    setBusyAction('upload');
    setNotice(null);
    try {
      const form = new FormData();
      form.append('file', selectedFile, selectedFile.name);
      form.append('expectedRevision', String(session.revision));

      const res = await fetch(`/api/v1/transactions/${encodeURIComponent(docTransactionId)}/documents`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: form,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = describeApiError(res.status, body);
        setNotice({ tone: 'err', title: 'Upload documental recusado', detail: err.message, code: err.code });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      const uploaded = body as {
        documentId: string;
        transactionId: string;
        sha256: string;
        sizeBytes: number;
        revision: number;
      };
      const updatedSession = { ...session, revision: uploaded.revision };
      setSession(updatedSession);
      setLastUploadedDoc(uploaded);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setNotice({
        tone: 'ok',
        title: 'Comprovante imutável anexado',
        detail: `SHA-256 ${uploaded.sha256.slice(0, 16)}… vinculado à movimentação (revisão #${uploaded.revision}).`,
      });
      await loadWorkspaceData(periodMonth, updatedSession);
    } catch {
      setNotice({ tone: 'err', title: 'Conexão interrompida', detail: 'Confira os comprovantes e a revisão antes de reenviar o arquivo.' });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCaptureDelivery(event: FormEvent) {
    event.preventDefault();
    if (!session || busyAction !== null || dataStatus !== 'ready') return;
    setBusyAction('capture');
    setNotice(null);
    try {
      const res = await fetch('/api/v1/deliveries', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrfToken,
          'Idempotency-Key': idempotencyKey.trim(),
        },
        body: JSON.stringify({
          periodMonth,
          expectedRevision: session.revision,
          rectificationReason: rectificationReason.trim(),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = describeApiError(res.status, body);
        setNotice({ tone: 'err', title: 'Captura mensal recusada', detail: err.message, code: err.code });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      const op = body as DeliveryOperation;
      setActiveOperation(op);
      setIdempotencyKey(generateIdempotencyKey());
      setRectificationReason('');
      setNotice({
        tone: 'ok',
        title:
          res.status === 200
            ? `Repetição idempotente reconhecida (v${op.versionNumber} · ${op.status})`
            : `Entrega v${op.versionNumber} iniciada (${op.status})`,
        detail: `Revisão capturada #${op.capturedRevision} sem avançar a revisão do acervo (#${session.revision}).`,
      });
      await loadWorkspaceData(periodMonth, session);
    } catch {
      setNotice({ tone: 'err', title: 'Conexão interrompida', detail: 'Atualize o histórico de versões antes de repetir a captura com a mesma chave.' });
    } finally {
      setBusyAction(null);
    }
  }

  function closeReimbursementPanel(restoreFocus = false) {
    reimbSequence.current += 1;
    setReimbPanel(null);
    setReimbCandidates(null);
    setReimbLoading(false);
    setReimbError(null);
    setReimbOutflowId('');
    setReimbInflowId('');
    setReimbNotes('');
    setReimbRevision(null);
    if (restoreFocus) restoreReimbursementFocus();
  }

  function restoreReimbursementFocus() {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const trigger = reimbTriggerRef.current;
      if (trigger?.isConnected && !(trigger as HTMLButtonElement).disabled) trigger.focus({ preventScroll: true });
      else pendingSectionRef.current?.focus({ preventScroll: true });
    }));
  }

  function focusReimbursementPanel() {
    setActiveSection('review');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.requestAnimationFrame(() => {
      reimbPanelRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      reimbPanelRef.current?.focus({ preventScroll: true });
    });
  }

  function beginReimbursementPanel(state: ReimbursementPanelState) {
    const active = document.activeElement;
    const trigger = active instanceof HTMLElement && active !== document.body ? active : reimbTriggerRef.current;
    closeReimbursementPanel();
    closeTransactionPanel();
    closePendingPanel();
    closeDocumentPanel();
    closeImportPanel();
    reimbTriggerRef.current = trigger;
    setReimbPanel(state);
    setReimbRevision(preview?.revision ?? null);
    focusReimbursementPanel();
  }

  async function openReimbursementLink(pfExpenseId: string) {
    if (!session || busyAction !== null || dataStatus !== 'ready') return;
    beginReimbursementPanel({ kind: 'link', pfExpenseId });
    const sequence = reimbSequence.current;
    const month = periodMonth;
    setReimbLoading(true);
    try {
      const res = await fetch(`/api/v1/reimbursements/candidates?pfExpenseId=${encodeURIComponent(pfExpenseId)}`, { credentials: 'same-origin' });
      const body = await res.json().catch(() => null);
      if (sequence !== reimbSequence.current || month !== periodMonth) return;
      if (!res.ok) {
        if (res.status === 401) {
          await loadWorkspaceData(periodMonth, session);
          return;
        }
        setReimbError(describeApiError(res.status, body).message);
        return;
      }
      if (!isReimbursementCandidates(body)) {
        setReimbError('Resposta inesperada ao carregar os candidatos. Atualize a visão e tente novamente.');
        return;
      }
      setReimbCandidates(body);
    } catch {
      if (sequence === reimbSequence.current) setReimbError('Não foi possível carregar os candidatos. Verifique a conexão e tente novamente.');
    } finally {
      if (sequence === reimbSequence.current) setReimbLoading(false);
    }
  }

  function openReimbursementUnlink(linkId: string) {
    if (!session || busyAction !== null || dataStatus !== 'ready') return;
    beginReimbursementPanel({ kind: 'unlink', linkId });
  }

  async function submitReimbursement(method: 'POST' | 'DELETE', url: string, payload: Record<string, unknown>, okTitle: string, failTitle: string) {
    if (!session || !preview || reimbRevision === null || preview.revision !== reimbRevision || busyAction !== null || dataStatus !== 'ready') return;
    setBusyAction('reimbursement');
    setNotice(null);
    try {
      const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ ...payload, expectedRevision: reimbRevision }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = describeApiError(res.status, body);
        setNotice({ tone: 'err', title: failTitle, detail: err.message, code: err.code });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      if (!isRevisionResult(body)) {
        closeReimbursementPanel();
        setNotice({ tone: 'err', title: 'Resposta inesperada do servidor', detail: 'A operação pode ter sido gravada. Confira os reembolsos na visão atualizada antes de repetir.' });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      const updatedSession = { ...session, revision: body.revision };
      setSession(updatedSession);
      closeReimbursementPanel();
      setNotice(body.revision === pendingPanelRevision
        ? { tone: 'ok', title: 'Nenhuma alteração', detail: `O texto enviado é igual ao existente; a revisão continua #${body.revision}.` }
        : { tone: 'ok', title: okTitle, detail: `Alteração gravada na revisão #${body.revision}.` });
      await loadWorkspaceData(periodMonth, updatedSession);
      restoreReimbursementFocus();
    } catch {
      setNotice({ tone: 'err', title: 'Conexão interrompida', detail: 'Atualize a visão e confira os reembolsos antes de repetir a operação.' });
    } finally {
      setBusyAction(null);
    }
  }

  function handleConfirmReimbursementLink(event: FormEvent) {
    event.preventDefault();
    if (reimbPanel?.kind !== 'link' || !reimbOutflowId) return;
    void submitReimbursement('POST', '/api/v1/reimbursements', {
      pfExpenseTransactionId: reimbPanel.pfExpenseId,
      pjReimbursementTransactionId: reimbOutflowId,
      pfInflowTransactionId: reimbInflowId || null,
      notes: reimbNotes.trim(),
    }, 'Reembolso vinculado', 'Vínculo de reembolso recusado');
  }

  function handleConfirmReimbursementUnlink() {
    if (reimbPanel?.kind !== 'unlink') return;
    void submitReimbursement('DELETE', `/api/v1/reimbursements/${encodeURIComponent(reimbPanel.linkId)}`, {}, 'Vínculo desfeito', 'Não foi possível desfazer o vínculo');
  }

  function closeTransactionPanel(restoreFocus = false) {
    txPanelSequence.current += 1;
    setTxPanel(null);
    setTxDraft(null);
    setTxPanelRevision(null);
    setTxPanelMessage(null);
    if (restoreFocus) restoreTransactionFocus();
  }

  function restoreTransactionFocus() {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const trigger = txPanelTriggerRef.current;
      if (trigger?.isConnected && !(trigger as HTMLButtonElement).disabled) trigger.focus({ preventScroll: true });
      else pendingSectionRef.current?.focus({ preventScroll: true });
    }));
  }

  function openTransactionPanel(kind: TransactionPanelState['kind'], tx: PreviewTransaction) {
    if (!session || busyAction !== null || dataStatus !== 'ready') return;
    const active = document.activeElement;
    const trigger = active instanceof HTMLElement && active !== document.body ? active : txPanelTriggerRef.current;
    closeReimbursementPanel();
    closeTransactionPanel();
    closePendingPanel();
    closeDocumentPanel();
    closeImportPanel();
    txPanelTriggerRef.current = trigger;
    setTxPanel({ kind, transactionId: tx.transactionId });
    setTxDraft(draftFromTransaction(tx));
    setTxPanelRevision(preview?.revision ?? null);
    setActiveSection('review');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.requestAnimationFrame(() => {
      txPanelRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      txPanelRef.current?.focus({ preventScroll: true });
    });
  }

  function updateTxDraft(change: Partial<TransactionDraft>) {
    setTxPanelMessage(null);
    setTxDraft((previous) => {
      if (!previous) return previous;
      const next = { ...previous, ...change };
      if (!allowedClassifications(next.direction).includes(next.classification)) {
        next.classification = next.direction === 'ENTRADA' ? 'RECEITA' : 'DESPESA';
      }
      const accountType = accounts.find((account) => account.id === next.accountId)?.accountType;
      if (!canMarkPfBusinessExpense(accountType, next.direction, next.classification)) next.isPfBusinessExpense = false;
      return next;
    });
  }

  function isTransactionLinked(transactionId: string) {
    return preview?.reimbursementLinks.some((link) => link.pfExpenseTransactionId === transactionId
      || link.pjReimbursementTransactionId === transactionId
      || link.pfInflowTransactionId === transactionId) ?? false;
  }

  async function submitTransactionChange(method: 'PATCH' | 'DELETE', transactionId: string, payload: Record<string, unknown>, okTitle: string, failTitle: string) {
    if (!session || !preview || txPanelRevision === null || preview.revision !== txPanelRevision || busyAction !== null || dataStatus !== 'ready') return;
    const sequence = txPanelSequence.current;
    const month = periodMonth;
    setBusyAction('transaction-change');
    txPanelRef.current?.focus({ preventScroll: true });
    setNotice(null);
    setTxPanelMessage(null);
    try {
      const res = await fetch(`/api/v1/transactions/${encodeURIComponent(transactionId)}`, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ ...payload, expectedRevision: txPanelRevision }),
      });
      const body = await res.json().catch(() => null);
      if (sequence !== txPanelSequence.current || month !== periodMonth) {
        if (res.status !== 401) await loadWorkspaceData(periodMonth, session);
        return;
      }
      if (!res.ok) {
        if (res.status === 401) {
          await loadWorkspaceData(periodMonth, session);
          return;
        }
        const err = describeApiError(res.status, body);
        setTxPanelMessage({ tone: 'err', text: err.message });
        setNotice({ tone: 'err', title: failTitle, detail: err.message, code: err.code });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      if (!isRevisionResult(body)) {
        closeTransactionPanel();
        setNotice({ tone: 'err', title: 'Resposta inesperada do servidor', detail: 'A operação pode ter sido gravada. Confira os lançamentos na visão atualizada antes de repetir.' });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      const updatedSession = { ...session, revision: body.revision };
      setSession(updatedSession);
      closeTransactionPanel();
      setNotice({ tone: 'ok', title: okTitle, detail: `Alteração gravada na revisão #${body.revision}.` });
      await loadWorkspaceData(periodMonth, updatedSession);
      restoreTransactionFocus();
    } catch {
      setNotice({ tone: 'err', title: 'Conexão interrompida', detail: 'Atualize a visão e confira o lançamento antes de repetir a operação.' });
    } finally {
      setBusyAction(null);
    }
  }

  function handleSubmitTransactionEdit(event: FormEvent) {
    event.preventDefault();
    if (txPanel?.kind !== 'edit' || !txDraft || !preview || busyAction !== null || dataStatus !== 'ready') return;
    const tx = preview.transactions.find((item) => item.transactionId === txPanel.transactionId);
    if (!tx) return;
    const amountCents = parseBrlCents(txDraft.amountInput);
    if (amountCents === null) {
      setTxPanelMessage({ tone: 'warn', text: 'Informe um valor positivo em reais com até 2 casas decimais (ex.: 12,50).' });
      return;
    }
    if (!txDraft.description.trim() || !txDraft.category.trim()) {
      setTxPanelMessage({ tone: 'warn', text: 'Descrição e categoria não podem ficar vazias.' });
      return;
    }
    const patch = buildTransactionPatch(
      {
        accountId: tx.accountId, occurredOn: tx.occurredOn, direction: tx.direction, amountCents: tx.amountCents,
        description: tx.descriptionOriginal, category: tx.categoryOriginal, classification: tx.classification,
        isPfBusinessExpense: tx.isPfBusinessExpense, explanation: tx.explanationOriginal,
      },
      { ...txDraft, amountCents },
    );
    if (patch === null) {
      setTxPanelMessage({ tone: 'warn', text: 'Nada foi alterado' });
      return;
    }
    void submitTransactionChange('PATCH', tx.transactionId, patch, 'Lançamento corrigido', 'Correção recusada');
  }

  function handleConfirmTransactionDelete() {
    if (txPanel?.kind !== 'delete' || isTransactionLinked(txPanel.transactionId)) return;
    void submitTransactionChange('DELETE', txPanel.transactionId, {}, 'Lançamento excluído', 'Exclusão recusada');
  }

  function closePendingPanel(restoreFocus = false) {
    pendingPanelSequence.current += 1;
    setPendingPanel(null);
    setPendingText('');
    setPendingPanelRevision(null);
    setPendingPanelMessage(null);
    if (restoreFocus) restorePendingFocus();
  }

  function restorePendingFocus() {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const trigger = pendingPanelTriggerRef.current;
      if (trigger?.isConnected && !(trigger as HTMLButtonElement).disabled) trigger.focus({ preventScroll: true });
      else pendingSectionRef.current?.focus({ preventScroll: true });
    }));
  }

  function focusPendingPanel() {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.requestAnimationFrame(() => {
      pendingPanelRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      pendingPanelRef.current?.focus({ preventScroll: true });
    });
  }

  function initialPendingText(state: PendingPanelState) {
    if (state.kind === 'create') return '';
    const item = preview?.pendingItems.find((entry) => entry.pendingId === state.pendingId);
    if (!item) return '';
    return state.kind === 'edit' ? item.description : state.kind === 'justify' ? item.justification : '';
  }

  function openPendingPanel(state: PendingPanelState) {
    if (!session || busyAction !== null || dataStatus !== 'ready') return;
    const active = document.activeElement;
    const trigger = active instanceof HTMLElement && active !== document.body ? active : pendingPanelTriggerRef.current;
    closeReimbursementPanel();
    closeTransactionPanel();
    closePendingPanel();
    closeDocumentPanel();
    closeImportPanel();
    pendingPanelTriggerRef.current = trigger;
    setPendingPanel(state);
    setPendingText(initialPendingText(state));
    setPendingPanelRevision(preview?.revision ?? null);
    setActiveSection('review');
    focusPendingPanel();
  }

  function switchPendingPanel(kind: 'justify' | 'edit' | 'resolve' | 'reopen', pendingId: string) {
    if (busyAction !== null || dataStatus !== 'ready') return;
    const state: PendingPanelState = { kind, pendingId };
    setPendingPanel(state);
    setPendingText(initialPendingText(state));
    setPendingPanelMessage(null);
    focusPendingPanel();
  }

  async function submitPendingChange(method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>, okTitle: string, failTitle: string) {
    if (!session || !preview || pendingPanelRevision === null || preview.revision !== pendingPanelRevision || busyAction !== null || dataStatus !== 'ready') return;
    const sequence = pendingPanelSequence.current;
    const month = periodMonth;
    setBusyAction('pending-change');
    pendingPanelRef.current?.focus({ preventScroll: true });
    setNotice(null);
    setPendingPanelMessage(null);
    try {
      const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ ...payload, expectedRevision: pendingPanelRevision }),
      });
      const body = await res.json().catch(() => null);
      if (sequence !== pendingPanelSequence.current || month !== periodMonth) {
        if (res.status !== 401) await loadWorkspaceData(periodMonth, session);
        return;
      }
      if (!res.ok) {
        if (res.status === 401) {
          await loadWorkspaceData(periodMonth, session);
          return;
        }
        const err = describePendingError(res.status, body);
        setPendingPanelMessage({ tone: 'err', text: err.message });
        setNotice({ tone: 'err', title: failTitle, detail: err.message, code: err.code });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      if (!isRevisionResult(body)) {
        closePendingPanel();
        setNotice({ tone: 'err', title: 'Resposta inesperada do servidor', detail: 'A operação pode ter sido gravada. Confira as pendências na visão atualizada antes de repetir.' });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      const updatedSession = { ...session, revision: body.revision };
      setSession(updatedSession);
      closePendingPanel();
      setNotice({ tone: 'ok', title: okTitle, detail: `Alteração gravada na revisão #${body.revision}.` });
      await loadWorkspaceData(periodMonth, updatedSession);
      restorePendingFocus();
    } catch {
      setNotice({ tone: 'err', title: 'Conexão interrompida', detail: 'Atualize a visão e confira as pendências antes de repetir a operação.' });
    } finally {
      setBusyAction(null);
    }
  }

  function handleSubmitPendingPanel(event: FormEvent) {
    event.preventDefault();
    if (!pendingPanel || pendingPanel.kind === 'manage' || !preview || busyAction !== null || dataStatus !== 'ready') return;
    if (pendingPanel.kind === 'create') {
      if (hasQuestion(preview.pendingItems, pendingPanel.transactionId)) return;
      const text = validatePendingText(pendingText);
      if (text.error) { setPendingPanelMessage({ tone: 'warn', text: text.error }); return; }
      void submitPendingChange('POST', `/api/v1/transactions/${encodeURIComponent(pendingPanel.transactionId)}/questions`, { description: text.value }, 'Dúvida registrada', 'Registro de dúvida recusado');
      return;
    }
    const item = preview.pendingItems.find((entry) => entry.pendingId === pendingPanel.pendingId);
    if (!item) return;
    const action = PENDING_PANEL_ACTION[pendingPanel.kind];
    if (!allowedPendingActions(item).includes(action)) return;
    const url = `/api/v1/pending-items/${encodeURIComponent(item.pendingId)}`;
    if (action === 'JUSTIFY' || action === 'EDIT') {
      const text = validatePendingText(pendingText);
      if (text.error) { setPendingPanelMessage({ tone: 'warn', text: text.error }); return; }
      if (action === 'JUSTIFY') void submitPendingChange('PATCH', url, { action, justification: text.value }, 'Justificativa registrada', 'Justificativa recusada');
      else void submitPendingChange('PATCH', url, { action, description: text.value }, 'Dúvida editada', 'Edição da dúvida recusada');
      return;
    }
    if (action === 'RESOLVE') void submitPendingChange('PATCH', url, { action }, 'Dúvida resolvida', 'Resolução recusada');
    else void submitPendingChange('PATCH', url, { action }, 'Dúvida reaberta', 'Reabertura recusada');
  }

  function renderPendingActions(item: PreviewPending) {
    const actions = allowedPendingActions(item);
    const locked = busyAction !== null || dataStatus !== 'ready';
    const automatic = item.pendingType !== 'DUVIDA_CADASTRADA';
    return <>
      {actions.map((action) => (
        <button key={action} type="button" className="btn btn-outline" disabled={locked} onClick={() => openPendingPanel({ kind: PENDING_ACTION_PANEL[action], pendingId: item.pendingId })}>{PENDING_ACTION_LABELS[action]}</button>
      ))}
      {automatic && item.status !== 'RESOLVIDA' && <span className="pending-guidance">{AUTOMATIC_PENDING_GUIDANCE}</span>}
    </>;
  }

  function invalidateImportResult() {
    importSequence.current += 1;
    setImportResult(null);
    setImportMessage(null);
  }

  function closeImportPanel(restoreFocus = false) {
    importSequence.current += 1;
    setImportOpen(false);
    setImportFile(null);
    setImportFileError(null);
    setImportResult(null);
    setImportMessage(null);
    setImportSource('');
    if (restoreFocus) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const trigger = importTriggerRef.current;
        if (trigger?.isConnected && !(trigger as HTMLButtonElement).disabled) trigger.focus({ preventScroll: true });
      }));
    }
  }

  function openImportPanel() {
    if (!session || busyAction !== null || dataStatus !== 'ready') return;
    const active = document.activeElement;
    const trigger = active instanceof HTMLElement && active !== document.body ? active : importTriggerRef.current;
    closeReimbursementPanel();
    closeTransactionPanel();
    closePendingPanel();
    closeDocumentPanel();
    closeImportPanel();
    importTriggerRef.current = trigger;
    setImportAccountId(accounts.find((account) => account.active)?.id ?? '');
    setImportMonth(periodMonth);
    setImportOpen(true);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.requestAnimationFrame(() => {
      importPanelRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      importPanelRef.current?.focus({ preventScroll: true });
    });
  }

  function chooseImportFile(file: File | null) {
    invalidateImportResult();
    setImportFile(file);
    setImportFileError(file ? validateImportFile(file) : null);
  }

  function buildImportForm(): FormData | null {
    const sourceCode = importSource.trim();
    if (!importAccountId) { setImportMessage('Escolha a conta de destino.'); return null; }
    if (!sourceCode) { setImportMessage('Informe o identificador da fonte.'); return null; }
    if (!isValidPeriodMonth(importMonth)) { setImportMessage('Informe o mês no formato AAAA-MM.'); return null; }
    const invalid = validateImportFile(importFile);
    if (invalid || !importFile) { setImportFileError(invalid); return null; }
    const form = new FormData();
    form.append('file', importFile, importFile.name);
    form.append('accountId', importAccountId);
    form.append('sourceCode', sourceCode);
    form.append('periodMonth', importMonth);
    return form;
  }

  async function handlePreviewImport(event: FormEvent) {
    event.preventDefault();
    if (!importOpen || !session || busyAction !== null || dataStatus !== 'ready') return;
    setImportMessage(null);
    const form = buildImportForm();
    if (!form) return;
    const sequence = importSequence.current;
    setImportResult(null);
    setBusyAction('import-preview');
    importPanelRef.current?.focus({ preventScroll: true });
    try {
      const res = await fetch('/api/v1/imports/preview', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': session.csrfToken }, body: form });
      const payload = await res.json().catch(() => null);
      if (sequence !== importSequence.current) return;
      if (res.status === 401) {
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      if (!res.ok) {
        setImportMessage(describeImportError(res.status, payload).message);
        return;
      }
      if (!isImportPreviewResult(payload)) {
        setImportMessage('Resposta inesperada do servidor. Tente pré-visualizar novamente.');
        return;
      }
      setImportResult(payload);
    } catch {
      if (sequence === importSequence.current) setImportMessage('Conexão interrompida. Tente pré-visualizar novamente.');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleConfirmImport() {
    if (!importOpen || !importResult || !importReady(importResult) || !session || busyAction !== null || dataStatus !== 'ready') return;
    const form = buildImportForm();
    if (!form) return;
    form.append('expectedFileHash', importResult.fileHash);
    form.append('expectedRevision', String(importResult.revision));
    const sequence = importSequence.current;
    const month = periodMonth;
    setBusyAction('import-confirm');
    importPanelRef.current?.focus({ preventScroll: true });
    setNotice(null);
    setImportMessage(null);
    try {
      const res = await fetch('/api/v1/imports/confirm', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': session.csrfToken }, body: form });
      const payload = await res.json().catch(() => null);
      if (sequence !== importSequence.current || month !== periodMonth) {
        if (res.status !== 401) await loadWorkspaceData(periodMonth, session);
        return;
      }
      if (res.status === 401) {
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      if (!res.ok) {
        const err = describeImportError(res.status, payload);
        setImportResult(null);
        setImportMessage(err.message);
        setNotice({ tone: 'err', title: 'Importação recusada', detail: err.message, code: err.code });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      if (!isImportConfirmation(payload)) {
        closeImportPanel();
        setNotice({ tone: 'err', title: 'Resposta inesperada do servidor', detail: 'A importação pode ter sido gravada. Confira os lançamentos na visão atualizada antes de repetir.' });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      if (res.status === 200) {
        closeImportPanel();
        setNotice({ tone: 'ok', title: 'Nada a importar', detail: 'Nenhuma linha nova; nada foi gravado.' });
        return;
      }
      const updatedSession = { ...session, revision: payload.revision };
      setSession(updatedSession);
      closeImportPanel();
      setNotice({ tone: 'ok', title: 'Importação concluída', detail: `${payload.transactionIds.length} lançamento(s) importado(s). Alteração gravada na revisão #${payload.revision}.` });
      await loadWorkspaceData(periodMonth, updatedSession);
    } catch {
      setNotice({ tone: 'err', title: 'Conexão interrompida', detail: 'Atualize a visão e confira os lançamentos importados antes de repetir a operação.' });
    } finally {
      setBusyAction(null);
    }
  }

  function closeDocumentPanel(restoreFocus = false) {
    documentPanelSequence.current += 1;
    setDocumentPanel(null);
    setDocumentPanelRevision(null);
    setDocumentPanelMessage(null);
    setDocumentPanelFile(null);
    setDocumentPanelFileError(null);
    setDocumentLinkId('');
    if (restoreFocus) restoreDocumentFocus();
  }

  function restoreDocumentFocus() {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const trigger = documentPanelTriggerRef.current;
      if (trigger?.isConnected && !(trigger as HTMLButtonElement).disabled) trigger.focus({ preventScroll: true });
      else pendingSectionRef.current?.focus({ preventScroll: true });
    }));
  }

  function openDocumentPanel(state: DocumentPanelState) {
    if (!session || busyAction !== null || dataStatus !== 'ready') return;
    const active = document.activeElement;
    const trigger = active instanceof HTMLElement && active !== document.body ? active : documentPanelTriggerRef.current;
    closeReimbursementPanel();
    closeTransactionPanel();
    closePendingPanel();
    closeDocumentPanel();
    closeImportPanel();
    documentPanelTriggerRef.current = trigger;
    setDocumentPanel(state);
    setDocumentPanelRevision(preview?.revision ?? null);
    setActiveSection('review');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.requestAnimationFrame(() => {
      documentPanelRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      documentPanelRef.current?.focus({ preventScroll: true });
    });
  }

  function chooseReplacementFile(file: File | null) {
    setDocumentPanelMessage(null);
    setDocumentPanelFile(file);
    setDocumentPanelFileError(file ? validateDocumentFile(file) : null);
  }

  async function handleSubmitDocumentPanel(event: FormEvent) {
    event.preventDefault();
    if (!documentPanel || !session || !preview || documentPanelRevision === null || preview.revision !== documentPanelRevision || busyAction !== null || dataStatus !== 'ready') return;
    const panel = documentPanel;
    const base = `/api/v1/transactions/${encodeURIComponent(panel.transactionId)}`;
    const headers: Record<string, string> = { 'X-CSRF-Token': session.csrfToken };
    let method: 'POST' | 'DELETE';
    let url: string;
    let body: string | FormData;
    let okTitle: string;
    let failTitle: string;
    let okDetail = '';
    if (panel.kind === 'replace') {
      if (!documentPanelFile) { setDocumentPanelMessage('Selecione um arquivo PDF, PNG ou JPEG de até 5 MiB.'); return; }
      const invalid = validateDocumentFile(documentPanelFile);
      if (invalid) { setDocumentPanelFileError(invalid); return; }
      const form = new FormData();
      form.append('file', documentPanelFile, documentPanelFile.name);
      form.append('replacedDocumentId', panel.documentId);
      form.append('expectedRevision', String(documentPanelRevision));
      method = 'POST'; url = `${base}/document-replacements`; body = form;
      okTitle = 'Documento substituído'; failTitle = 'Substituição recusada';
    } else if (panel.kind === 'link') {
      if (!documentLinkId) { setDocumentPanelMessage('Escolha o documento a vincular.'); return; }
      headers['Content-Type'] = 'application/json';
      method = 'POST'; url = `${base}/document-links`; body = JSON.stringify({ documentId: documentLinkId, expectedRevision: documentPanelRevision });
      okTitle = 'Documento vinculado'; failTitle = 'Vínculo recusado';
    } else {
      headers['Content-Type'] = 'application/json';
      method = 'DELETE'; url = `${base}/document-links/${encodeURIComponent(panel.documentId)}`; body = JSON.stringify({ expectedRevision: documentPanelRevision });
      okTitle = 'Documento desvinculado'; failTitle = 'Desvínculo recusado';
      const tx = preview.transactions.find((item) => item.transactionId === panel.transactionId);
      const remaining = documentsByTransaction(documents).get(panel.transactionId)?.filter((doc) => doc.documentId !== panel.documentId).length ?? 0;
      if (tx && remaining === 0 && (tx.classification === 'RECEITA' || tx.classification === 'DESPESA')) {
        okDetail = ' O lançamento ficou sem comprovante e a pendência de comprovante ausente voltou.';
      }
    }
    const sequence = documentPanelSequence.current;
    const month = periodMonth;
    setBusyAction('document-change');
    documentPanelRef.current?.focus({ preventScroll: true });
    setNotice(null);
    setDocumentPanelMessage(null);
    try {
      const res = await fetch(url, { method, credentials: 'same-origin', headers, body });
      const payload = await res.json().catch(() => null);
      if (sequence !== documentPanelSequence.current || month !== periodMonth) {
        if (res.status !== 401) await loadWorkspaceData(periodMonth, session);
        return;
      }
      if (!res.ok) {
        if (res.status === 401) {
          await loadWorkspaceData(periodMonth, session);
          return;
        }
        const err = describeDocumentError(res.status, payload);
        setDocumentPanelMessage(err.message);
        setNotice({ tone: 'err', title: failTitle, detail: err.message, code: err.code });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      if (!isRevisionResult(payload)) {
        closeDocumentPanel();
        setNotice({ tone: 'err', title: 'Resposta inesperada do servidor', detail: 'A operação pode ter sido gravada. Confira os documentos na visão atualizada antes de repetir.' });
        await loadWorkspaceData(periodMonth, session);
        return;
      }
      const updatedSession = { ...session, revision: payload.revision };
      setSession(updatedSession);
      closeDocumentPanel();
      setNotice({ tone: 'ok', title: okTitle, detail: `Alteração gravada na revisão #${payload.revision}.${okDetail}` });
      await loadWorkspaceData(periodMonth, updatedSession);
      restoreDocumentFocus();
    } catch {
      setNotice({ tone: 'err', title: 'Conexão interrompida', detail: 'Atualize a visão e confira os documentos do lançamento antes de repetir a operação.' });
    } finally {
      setBusyAction(null);
    }
  }

  function describeTransaction(transactionId: string | null) {
    if (!transactionId || !preview) return 'Não informada';
    const tx = [...preview.transactions, ...preview.contextTransactions].find((item) => item.transactionId === transactionId);
    return tx ? `${tx.descriptionOriginal} · ${tx.occurredOn} · ${formatBrlCents(tx.amountCents)}` : 'Lançamento fora da visão carregada';
  }

  const requiresRectification = nextVersionRequiresReason(deliveries);
  const nextAction = nextMonthAction({ loaded: dataStatus === 'ready', accounts, preview, deliveries });
  const latestDelivery = deliveries.reduce<DeliveryOperation | null>((latest, item) => !latest || item.versionNumber > latest.versionNumber ? item : latest, null);
  const documentsByTx = documentsByTransaction(documents);
  const openPendings = preview?.pendingItems.filter((item) => item.status === 'PENDENTE') ?? [];
  const otherPendings = preview?.pendingItems.filter((item) => item.status !== 'PENDENTE') ?? [];
  const nextActionContent = (() => {
    switch (nextAction.kind) {
      case 'accounts': return { title: 'Comece pelas contas', detail: 'Cadastre uma conta PF ou PJ para registrar o movimento do mês.', button: 'Cadastrar conta' };
      case 'transactions': return { title: 'Registre o primeiro lançamento', detail: 'Adicione uma receita, despesa ou transferência para começar a revisão.', button: 'Criar lançamento' };
      case 'document': {
        const tx = preview?.transactions.find((item) => item.transactionId === nextAction.transactionId);
        return { title: 'Falta um comprovante', detail: tx ? `${tx.descriptionOriginal} · ${tx.occurredOn} · ${formatBrlCents(tx.amountCents)}` : 'Anexe o comprovante deste lançamento para atualizar a pendência.', button: 'Anexar comprovante' };
      }
      case 'reimbursement': {
        const tx = preview?.transactions.find((item) => item.transactionId === nextAction.transactionId);
        return { title: 'Falta vincular um reembolso', detail: tx ? `${tx.descriptionOriginal} · ${tx.occurredOn} · ${formatBrlCents(tx.amountCents)}` : 'Escolha a transferência PJ que reembolsou esta despesa paga em conta PF.', button: 'Vincular reembolso' };
      }
      case 'question': {
        const item = preview?.pendingItems.find((entry) => entry.pendingType === 'DUVIDA_CADASTRADA' && entry.status === 'PENDENTE' && entry.transactionId === nextAction.transactionId);
        return { title: 'Revise a dúvida registrada', detail: item ? item.description : 'Há uma dúvida em aberto neste mês. Justifique ou resolva para seguir.', button: 'Revisar dúvida' };
      }
      case 'review': return { title: 'Confira as pendências', detail: 'Confira estes itens. Eles continuarão registrados na entrega.', button: 'Ver pendências' };
      case 'capture': return { title: latestDelivery?.status === 'FALHA' ? 'Prepare uma nova entrega' : latestDelivery ? 'O acervo mudou desde a última entrega' : 'Pronto para preparar a entrega', detail: latestDelivery?.status === 'FALHA' ? 'A última operação falhou. Uma nova captura gera outra versão.' : latestDelivery ? 'A versão anterior preserva a revisão capturada. Prepare uma nova versão para incluir alterações recentes.' : 'Os lançamentos do mês podem ser preservados em um pacote auditável.', button: 'Abrir entregas' };
      case 'delivery': return { title: latestDelivery?.status === 'PRONTA' ? `Entrega v${latestDelivery.versionNumber} disponível` : `Entrega v${latestDelivery?.versionNumber ?? ''} em preparo`, detail: latestDelivery?.status === 'PRONTA' ? 'Baixe o pacote e o manifesto para conferência independente.' : 'Acompanhe a preparação do pacote; o status atualiza automaticamente.', button: 'Ver entrega' };
      default: return { title: dataStatus === 'error' ? 'Não foi possível carregar o mês' : 'Carregando o mês', detail: dataStatus === 'error' ? 'Atualize a visão para decidir o próximo passo com dados completos.' : 'Aguarde a prévia e o histórico de entregas.', button: 'Atualizar visão' };
    }
  })();

  function openNextAction() {
    if (nextAction.kind === 'document') { chooseUploadTransaction(nextAction.transactionId); return; }
    if (nextAction.kind === 'reimbursement') { void openReimbursementLink(nextAction.transactionId); return; }
    if (nextAction.kind === 'question') {
      const item = preview?.pendingItems.find((entry) => entry.pendingType === 'DUVIDA_CADASTRADA' && entry.status === 'PENDENTE' && entry.transactionId === nextAction.transactionId);
      if (item) openPendingPanel({ kind: 'manage', pendingId: item.pendingId });
      return;
    }
    if (nextAction.kind === 'loading') { void loadWorkspaceData(periodMonth, session); return; }
    if (nextAction.kind === 'accounts' || nextAction.kind === 'transactions') { setActiveSection(nextAction.kind); return; }
    if (nextAction.kind === 'capture' || nextAction.kind === 'delivery') { setActiveSection('deliveries'); return; }
    setActiveSection('review');
    window.requestAnimationFrame(() => {
      pendingSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      pendingSectionRef.current?.focus({ preventScroll: true });
    });
  }
  const selectedDocumentTransaction = preview?.transactions.find((tx) => tx.transactionId === docTransactionId);
  const enteredCents = parseBrlCents(txAmountInput);
  const suggestedCategories = [...new Set((preview?.transactions ?? []).map((tx) => tx.categoryOriginal))].slice(0, 8);

  function chooseUploadTransaction(transactionId: string) {
    setDocTransactionId(transactionId);
    setActiveSection('documents');
    window.requestAnimationFrame(() => {
      uploadSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      fileInputRef.current?.focus({ preventScroll: true });
    });
  }

  function chooseFile(file: File | null) {
    setSelectedFile(file);
    setFileError(file ? validateDocumentFile(file) : null);
  }

  async function copyVerifierCommand(op: DeliveryOperation) {
    try {
      await navigator.clipboard.writeText(buildVerifierCommand(op.periodMonth, op.versionNumber));
      setCopiedOperationId(op.id);
      window.setTimeout(() => setCopiedOperationId((previous) => previous === op.id ? null : previous), 2400);
    } catch {
      setNotice({ tone: 'warn', title: 'Cópia indisponível', detail: 'Selecione e copie o comando exibido abaixo.' });
    }
  }

  return (
    <div className="ledger-shell">
      <header className="masthead">
        <div className="masthead-brand">
          <div className="brand-mark" aria-hidden="true">M</div>
          <div>
            <h1>Mimir Contabilidade</h1>
            {!session && <p className="brand-subtitle">Seu caderno financeiro mensal</p>}
          </div>
        </div>

        {session ? (
          <div className="masthead-meta">
            <span className="workspace-name">{session.workspace.companyName}</span>
            <details className="workspace-menu"><summary>Espaço e sessão</summary><div className="workspace-menu-content">
              <span>Revisão do acervo <strong className="mono">#{session.revision}</strong></span>
              <button type="button" className="btn btn-quiet" disabled={busyAction !== null} onClick={() => void loadWorkspaceData(periodMonth, session)}>Atualizar visão</button>
              <button type="button" className="btn btn-outline" disabled={busyAction !== null} onClick={() => void handleLogout()}>Encerrar sessão</button>
            </div></details>
          </div>
        ) : (
          <div className="masthead-meta">
            <span className="security-tag">Acesso protegido ao seu espaço</span>
          </div>
        )}
      </header>

      {notice && (
        <section className={`status-banner tone-${notice.tone}`} role="status" aria-live="polite">
          <div>
            <strong>{notice.title}</strong>
            {notice.code ? <span className="mono error-code">{notice.code}</span> : null}
            <p>{notice.detail}</p>
          </div>
          <button type="button" className="btn-dismiss" onClick={() => setNotice(null)} aria-label="Fechar aviso">
            Fechar
          </button>
        </section>
      )}

      {booting ? (
        <main className="auth-stage">
          <section className="ledger-sheet auth-sheet">
            <h2>Verificando sessão ativa…</h2>
            <p>Preparando seu caderno mensal.</p>
          </section>
        </main>
      ) : !session ? (
        <main className="auth-stage">
          <section className="ledger-sheet auth-sheet">
            <div className="sheet-header">
              <h2>Acesso do proprietário</h2>
              <p>
                Entre com o e-mail e a senha fornecidos na criação do seu espaço para abrir o caderno mensal.
              </p>
            </div>

            <form className="ledger-form" onSubmit={(e) => void handleLogin(e)}>
              <label className="field">
                <span>E-mail do proprietário</span>
                <input
                  type="email"
                  required
                  autoComplete="username"
                  placeholder="operador@empresa.exemplo"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                />
              </label>

              <label className="field">
                <span>Senha</span>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  placeholder="Sua senha de acesso"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                />
              </label>

              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={busyAction === 'login'}>
                  {busyAction === 'login' ? 'Autenticando…' : 'Abrir caderno mensal'}
                </button>
              </div>
            </form>

            <footer className="auth-footnotes">
              <div className="footnote-item">
                <strong>Isolamento por espaço</strong>
                <p>Suas contas, lançamentos e comprovantes ficam reunidos em um espaço exclusivo.</p>
              </div>
              <div className="footnote-item">
                <strong>Entregas auditáveis</strong>
                <p>Feche o mês e entregue um pacote que pode ser conferido de forma independente.</p>
              </div>
            </footer>
          </section>
        </main>
      ) : (
        <main className="workbench">
          <nav className="journey-nav" aria-label="Etapas do fechamento mensal">
            {JOURNEY.map((step) => (
              <button key={step.id} type="button" className={`journey-step ${activeSection === step.id ? 'is-current' : ''}`}
                aria-current={activeSection === step.id ? 'step' : undefined}
                onClick={() => setActiveSection(step.id)}>
                <span>{step.label}</span><Icon name="arrow" />
              </button>
            ))}
          </nav>
          <section className="period-bar ledger-sheet" aria-label="Seleção de competência e resumo executivo">
            <div className="period-controls">
              <div>
                <span className="section-kicker">Competência em preparo</span>
                <h2 className="period-heading mono">{periodMonth}</h2>
              </div>

              <div className="period-nav">
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={busyAction !== null}
                  onClick={() => void changeMonth(shiftPeriodMonth(periodMonth, -1))}
                >
                  Anterior
                </button>
                <form
                  className="month-jump"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void changeMonth(monthDraft.trim());
                  }}
                >
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="\d{4}-(0[1-9]|1[0-2])"
                    aria-label="Competência no formato AAAA-MM"
                    value={monthDraft}
                    onChange={(e) => setMonthDraft(e.target.value)}
                    className="mono month-input"
                  />
                  <button type="submit" className="btn btn-outline" disabled={busyAction !== null}>
                    Ir
                  </button>
                </form>
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={busyAction !== null}
                  onClick={() => void changeMonth(shiftPeriodMonth(periodMonth, 1))}
                >
                  Próximo
                </button>
              </div>
            </div>

            <p className="period-inline-status">
              {dataStatus === 'ready' && preview ? `${preview.summary.pendingCount} pendência(s) aberta(s) · ${preview.transactions.length} lançamento(s)` : dataStatus === 'error' ? 'Dados do mês indisponíveis' : 'Carregando dados do mês…'}
            </p>
          </section>

          <div className="workbench-grid">
            <div className="workbench-column">
              {/* 1. Contas PF / PJ */}
              {activeSection === 'accounts' && <section className="ledger-sheet" aria-labelledby="heading-accounts">
                <div className="sheet-header">
                  <div>
                    <span className="section-kicker">Acervo do espaço</span>
                    <h2 id="heading-accounts">Contas bancárias e caixa (PF / PJ)</h2>
                  </div>
                  {dataStatus === 'ready' && <span className="count-badge mono">{accounts.length} contas</span>}
                </div>

                {dataStatus !== 'ready' ? <p className="empty-hint">{dataStatus === 'error' ? 'Não foi possível carregar as contas. Atualize a visão.' : 'Carregando contas…'}</p> : accounts.length === 0 ? (
                  <p className="empty-hint">
                    Nenhuma conta cadastrada. Cadastre a primeira conta PF ou PJ abaixo para habilitar os lançamentos.
                  </p>
                ) : (
                  <ul className="account-list">
                    {accounts.map((acc) => (
                      <li key={acc.id} className="account-row">
                        <div>
                          <span className={`account-tag tag-${acc.accountType.toLowerCase()}`}>{acc.accountType}</span>
                          <strong>{acc.name}</strong>
                        </div>
                        <code className="mono uuid-short">{acc.id.slice(0, 8)}</code>
                      </li>
                    ))}
                  </ul>
                )}

                <form className="ledger-form compact-form" onSubmit={(e) => void handleCreateAccount(e)}>
                  <div className="form-row">
                    <label className="field field-grow">
                      <span>Nome da nova conta</span>
                      <input
                        type="text"
                        required
                        maxLength={200}
                        placeholder="Ex.: Banco PJ Principal ou Conta PF Sócia"
                        value={newAccountName}
                        onChange={(e) => setNewAccountName(e.target.value)}
                      />
                    </label>
                    <label className="field field-narrow">
                      <span>Natureza</span>
                      <select
                        value={newAccountType}
                        onChange={(e) => setNewAccountType(e.target.value as AccountType)}
                      >
                        <option value="PJ">PJ</option>
                        <option value="PF">PF</option>
                      </select>
                    </label>
                  </div>
                  <div className="form-actions">
                    <button type="submit" className="btn btn-primary" disabled={busyAction !== null || dataStatus !== 'ready'}>
                      {busyAction === 'account' ? 'Salvando…' : `Adicionar conta (rev. #${session.revision})`}
                    </button>
                  </div>
                </form>
              </section>}

              {/* 2. Novo lançamento manual */}
              {activeSection === 'transactions' && <section className="ledger-sheet" aria-labelledby="heading-tx-form">
                <div className="sheet-header">
                  <div>
                    <span className="section-kicker">Organize o mês</span>
                    <h2 id="heading-tx-form">Novo lançamento manual</h2>
                  </div>
                  <span className="mono revision-inline">Revisão #{session.revision}</span>
                </div>

                {!importOpen && <div className="form-actions">
                  <button type="button" className="btn btn-outline" disabled={busyAction !== null || dataStatus !== 'ready' || !accounts.some((account) => account.active)} onClick={openImportPanel}>Importar CSV</button>
                </div>}

                {importOpen && (() => {
                  const canSubmit = busyAction === null && dataStatus === 'ready';
                  const ready = importReady(importResult);
                  return <section className="reimb-panel" role="dialog" aria-modal="false" aria-labelledby="heading-import-panel" tabIndex={-1} ref={importPanelRef}
                    onKeyDown={(event) => { if (event.key === 'Escape' && busyAction === null) closeImportPanel(true); }}>
                    <h3 id="heading-import-panel">Importar lançamentos de CSV</h3>
                    <form onSubmit={(event) => void handlePreviewImport(event)}>
                      <div className="form-row">
                        <label className="field field-grow">
                          <span>Conta de destino</span>
                          <select value={importAccountId} disabled={busyAction !== null} onChange={(e) => { invalidateImportResult(); setImportAccountId(e.target.value); }}>
                            {accounts.filter((account) => account.active).map((account) => (
                              <option key={account.id} value={account.id}>[{account.accountType}] {account.name}</option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          <span>Mês do arquivo (AAAA-MM)</span>
                          <input type="text" className="mono" inputMode="numeric" maxLength={7} placeholder="2026-10" value={importMonth} disabled={busyAction !== null}
                            aria-invalid={importMonth !== '' && !isValidPeriodMonth(importMonth)} onChange={(e) => { invalidateImportResult(); setImportMonth(e.target.value); }} />
                        </label>
                      </div>
                      <label className="field">
                        <span>Identificador da fonte</span>
                        <input type="text" maxLength={80} placeholder="banco-x-extrato" value={importSource} disabled={busyAction !== null} onChange={(e) => { invalidateImportResult(); setImportSource(e.target.value); }} />
                        <small className="row-sub">Use sempre o mesmo identificador para a mesma fonte; trocar cria novas identidades.</small>
                      </label>
                      <label className="field">
                        <span>Arquivo CSV (até 1 MiB)</span>
                        <input id="import-panel-file" type="file" accept=".csv,text/csv" disabled={busyAction !== null} aria-invalid={importFileError !== null}
                          onChange={(e) => chooseImportFile(e.target.files?.[0] ?? null)} />
                      </label>
                      {importFileError && <p className="field-error" role="alert">{importFileError}</p>}
                      <p className="context-note">A importação é tudo ou nada: com qualquer linha inválida ou em conflito, nada é gravado.</p>
                      {importMessage && <p className="field-error" role="alert">{importMessage}</p>}
                      <div className="form-actions">
                        <button type="submit" className="btn btn-outline" disabled={!canSubmit || !importFile || importFileError !== null}>{busyAction === 'import-preview' ? 'Lendo arquivo…' : 'Pré-visualizar'}</button>
                        <button type="button" className="btn btn-primary" disabled={!canSubmit || !ready} onClick={() => void handleConfirmImport()}>{busyAction === 'import-confirm' ? 'Importando…' : 'Confirmar importação'}</button>
                        <button type="button" className="btn btn-outline" disabled={busyAction !== null} onClick={() => closeImportPanel(true)}>Cancelar</button>
                      </div>
                    </form>
                    {importResult && <div role="status">
                      {!importResult.sourceCodeKnown && <p className="context-note">Fonte nova nesta conta: as linhas serão tratadas como novas identidades.</p>}
                      <p className="row-sub">
                        {IMPORT_TOTAL_LABELS.map(([key, label]) => `${label}: ${importResult.totals[key]}`).join(' · ')}
                      </p>
                      {ready && importResult.totals.new === 0 && <p className="context-note">Nenhuma linha nova: confirmar não grava nada.</p>}
                      {!ready && <p className="field-error">Corrija o arquivo: há linhas inválidas ou em conflito.</p>}
                      <div className="table-scroll" tabIndex={0} role="region" aria-label="Prévia da importação, rolável horizontalmente">
                        <table className="ledger-table">
                          <thead>
                            <tr><th>Linha</th><th>external_id</th><th>Situação</th><th>Motivo</th></tr>
                          </thead>
                          <tbody>
                            {importResult.rows.map((row) => (
                              <tr key={row.line}>
                                <td className="mono">{row.line}</td>
                                <td className="mono">{row.externalId ?? '—'}</td>
                                <td><span className="status-chip">{importStatusLabel(row.status)}</span></td>
                                <td>
                                  {row.code ? importReasonLabel(row.code) : ''}
                                  {row.message && <div className="row-sub">{row.message}</div>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>}
                  </section>;
                })()}

                <form className="ledger-form" onSubmit={(e) => void handleCreateTransaction(e)}>
                  <div className="form-row">
                    <label className="field field-grow">
                      <span>Conta da movimentação</span>
                      <select
                        required
                        value={txAccountId}
                        onChange={(e) => setTxAccountId(e.target.value)}
                        disabled={accounts.length === 0}
                      >
                        {accounts.length === 0 ? (
                          <option value="">Cadastre uma conta primeiro</option>
                        ) : (
                          accounts.map((acc) => (
                            <option key={acc.id} value={acc.id}>
                              [{acc.accountType}] {acc.name}
                            </option>
                          ))
                        )}
                      </select>
                    </label>

                    <label className="field">
                      <span>Data civil</span>
                      <input
                        type="date"
                        required
                        value={txDate}
                        onChange={(e) => setTxDate(e.target.value)}
                        className="mono"
                      />
                    </label>
                  </div>

                  <div className="form-row">
                    <label className="field">
                      <span>Direção</span>
                      <select
                        value={txDirection}
                        onChange={(e) => setTxDirection(e.target.value as Direction)}
                      >
                        <option value="SAIDA">SAÍDA</option>
                        <option value="ENTRADA">ENTRADA</option>
                      </select>
                    </label>

                    <label className="field">
                      <span>Classificação</span>
                      <select
                        value={txClassification}
                        onChange={(e) => setTxClassification(e.target.value as Classification)}
                      >
                        {validClassifications.map((cls) => (
                          <option key={cls} value={cls}>
                            {CLASSIFICATION_LABELS[cls]}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="field">
                      <span>Valor (BRL)</span>
                      <input
                        type="text"
                        required
                        inputMode="decimal"
                        placeholder="12,50"
                        value={txAmountInput}
                        onChange={(e) => setTxAmountInput(e.target.value)}
                        className="mono"
                      />
                      <small className={`amount-feedback ${enteredCents === null ? 'is-invalid' : ''}`} aria-live="polite">
                        {enteredCents === null ? 'Digite um valor positivo, por exemplo 125,50.' : `Valor do lançamento: ${formatBrlCents(enteredCents)}`}
                      </small>
                    </label>
                  </div>

                  <div className="form-row">
                    <label className="field">
                      <span>Categoria</span>
                      <input
                        type="text"
                        required
                        maxLength={100}
                        list="month-categories"
                        placeholder="Geral, Hospedagem, Tributos…"
                        value={txCategory}
                        onChange={(e) => setTxCategory(e.target.value)}
                      />
                      <datalist id="month-categories">{suggestedCategories.map((category) => <option key={category} value={category} />)}</datalist>
                    </label>

                    <label className="field field-grow">
                      <span>Descrição da operação</span>
                      <input
                        type="text"
                        required
                        maxLength={500}
                        placeholder="Descrição para o relatório e planilha CSV"
                        value={txDescription}
                        onChange={(e) => setTxDescription(e.target.value)}
                      />
                    </label>
                  </div>

                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={txPfBusiness}
                      disabled={!canMarkPfBusinessExpense(selectedAccount?.accountType, txDirection, txClassification)}
                      onChange={(e) => setTxPfBusiness(e.target.checked)}
                    />
                    <span>
                      Despesa empresarial paga em conta PF (gera pendência de reembolso PF até liquidação)
                    </span>
                  </label>
                  {txPfBusiness && <p className="context-note">Esta despesa entra no total empresarial e cria a pendência <strong>PENDENTE_REEMBOLSO</strong> até a liquidação do reembolso PF.</p>}

                  <label className="field">
                    <span>Explicação complementar (opcional)</span>
                    <input
                      type="text"
                      maxLength={2000}
                      placeholder="Contexto operacional para o contador"
                      value={txExplanation}
                      onChange={(e) => setTxExplanation(e.target.value)}
                    />
                  </label>

                  <div className="form-actions">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={accounts.length === 0 || busyAction !== null || dataStatus !== 'ready'}
                    >
                      {busyAction === 'transaction' ? 'Registrando…' : 'Registrar lançamento manual'}
                    </button>
                  </div>
                </form>
              </section>}

              {/* 3. Upload documental imutável */}
              {activeSection === 'documents' && <section className="ledger-sheet" aria-labelledby="heading-upload" ref={uploadSectionRef}>
                <div className="sheet-header">
                  <div>
                    <span className="section-kicker">Lastro documental</span>
                    <h2 id="heading-upload">Anexar comprovante imutável (PDF / PNG / JPEG)</h2>
                  </div>
                  <span className="mono revision-inline">até 5 MiB</span>
                </div>

                {selectedDocumentTransaction ? (
                  <div className="selected-transaction" role="status">
                    <span className="section-kicker">Comprovante para este lançamento</span>
                    <strong>{selectedDocumentTransaction.descriptionOriginal}</strong>
                    <span>{selectedDocumentTransaction.occurredOn} · {selectedDocumentTransaction.accountName} · {formatBrlCents(selectedDocumentTransaction.amountCents)}</span>
                  </div>
                ) : <p className="empty-hint">Ainda não há lançamento para receber um comprovante. Registre um lançamento primeiro.</p>}

                <form className="ledger-form" onSubmit={(e) => void handleUploadDocument(e)}>
                  <label className="field">
                    <span>Lançamento da competência {periodMonth}</span>
                    <select
                      required
                      value={docTransactionId}
                      onChange={(e) => setDocTransactionId(e.target.value)}
                      disabled={(preview?.transactions.length ?? 0) === 0}
                    >
                      {dataStatus !== 'ready' ? (
                        <option value="">Carregando lançamentos do mês</option>
                      ) : (preview?.transactions.length ?? 0) === 0 ? (
                        <option value="">Nenhum lançamento no mês selecionado</option>
                      ) : (
                        preview!.transactions.map((tx) => (
                          <option key={tx.transactionId} value={tx.transactionId}>
                            {tx.occurredOn} · [{tx.accountType}] {tx.descriptionOriginal} ({formatBrlCents(tx.amountCents)}) — {tx.documentIds.length} anexo(s)
                          </option>
                        ))
                      )}
                    </select>
                  </label>

                  <div className={`drop-zone ${draggingFile ? 'is-dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDraggingFile(true); }}
                    onDragLeave={() => setDraggingFile(false)} onDrop={(event) => { event.preventDefault(); setDraggingFile(false); chooseFile(event.dataTransfer.files[0] ?? null); }}>
                    <Icon name="upload" />
                    <strong>Arraste o comprovante aqui</strong>
                    <span>ou selecione um arquivo PDF, PNG ou JPEG de até 5 MiB</span>
                    <label className="btn btn-outline upload-picker">
                    Escolher arquivo
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                      onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
                    />
                    </label>
                  </div>
                  {selectedFile && <div className="file-preview"><Icon name="check" /><span><strong>{selectedFile.name}</strong><small>{selectedFile.size < 1024 ? `${selectedFile.size} bytes` : `${(selectedFile.size / 1024).toFixed(0)} KiB`} · {selectedFile.type || 'tipo desconhecido'}</small></span><button type="button" className="btn-link" onClick={() => { chooseFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}>Remover</button></div>}
                  {fileError && <p className="field-error" role="alert">{fileError}</p>}

                  <div className="form-actions">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={!docTransactionId || !selectedFile || !!fileError || busyAction !== null || dataStatus !== 'ready'}
                    >
                      {busyAction === 'upload' ? 'Enviando e reconciliando…' : 'Anexar comprovante e reconciliar'}
                    </button>
                  </div>
                </form>

                {lastUploadedDoc && (
                  <div className="upload-receipt">
                    <span>Último documento gravado</span>
                    <code className="mono">
                      ID {lastUploadedDoc.documentId.slice(0, 8)}… · {lastUploadedDoc.sizeBytes} bytes · SHA-256{' '}
                      {lastUploadedDoc.sha256.slice(0, 24)}…
                    </code>
                  </div>
                )}
              </section>}
            </div>

            <div className="workbench-column">
              {/* 4. Prévia Mensal: Fluxo por Conta e Totais por Categoria */}
              {activeSection === 'review' && <section className="ledger-sheet" aria-labelledby="heading-preview-totals">
                <div className="next-action" role="status">
                  <span className="section-kicker">Próximo passo</span>
                  <h2 id="heading-preview-totals">{nextActionContent.title}</h2>
                  <p>{nextActionContent.detail}</p>
                  <button type="button" className="btn btn-primary" disabled={busyAction !== null || ((nextAction.kind === 'reimbursement' || nextAction.kind === 'question') && dataStatus !== 'ready')} onClick={openNextAction}>{nextActionContent.button} <Icon name="arrow" /></button>
                </div>

                {reimbPanel && <section className="reimb-panel" role="dialog" aria-modal="false" aria-labelledby="heading-reimb" tabIndex={-1} ref={reimbPanelRef}
                  onKeyDown={(event) => { if (event.key === 'Escape' && busyAction === null) closeReimbursementPanel(true); }}>
                  {reimbPanel.kind === 'unlink' ? (() => {
                    const link = preview?.reimbursementLinks.find((item) => item.reimbursementLinkId === reimbPanel.linkId);
                    return <>
                      <h3 id="heading-reimb">Desfazer vínculo de reembolso</h3>
                      {link ? <p>A despesa <strong>{describeTransaction(link.pfExpenseTransactionId)}</strong> voltará a ficar com reembolso pendente. O vínculo de {formatBrlCents(link.amountCents)} ficará registrado como desfeito; entregas já capturadas não mudam.</p> : <p className="empty-hint">Este vínculo não está mais na visão do mês. Atualize a visão.</p>}
                      <div className="form-actions">
                        <button type="button" className="btn btn-primary" disabled={!link || busyAction !== null || dataStatus !== 'ready'} onClick={handleConfirmReimbursementUnlink}>{busyAction === 'reimbursement' ? 'Desfazendo…' : 'Confirmar: desfazer vínculo'}</button>
                        <button type="button" className="btn btn-outline" disabled={busyAction !== null} onClick={() => closeReimbursementPanel(true)}>Cancelar</button>
                      </div>
                    </>;
                  })() : <form onSubmit={handleConfirmReimbursementLink}>
                    <h3 id="heading-reimb">Vincular reembolso</h3>
                    {reimbLoading && <p className="empty-hint" role="status">Carregando candidatos…</p>}
                    {reimbError && <p className="field-error" role="alert">{reimbError}</p>}
                    {reimbCandidates && <>
                      <p className="reimb-expense"><strong>{reimbCandidates.pfExpense.descriptionOriginal}</strong><span>{reimbCandidates.pfExpense.occurredOn} · {reimbCandidates.pfExpense.accountName} · {formatBrlCents(reimbCandidates.pfExpense.amountCents)}</span></p>
                      {reimbCandidates.pjOutflows.length === 0 ? (
                        <p className="context-note">Não há saída PJ compatível. Lance primeiro a transferência PJ de mesmo valor que reembolsou esta despesa; o vínculo é sempre escolhido por você.</p>
                      ) : <>
                        <fieldset className="reimb-options">
                          <legend>Saída PJ que reembolsou a despesa</legend>
                          {reimbCandidates.pjOutflows.map((item) => (
                            <label key={item.transactionId} className="reimb-option">
                              <input type="radio" name="reimb-outflow" value={item.transactionId} checked={reimbOutflowId === item.transactionId}
                                onChange={() => { setReimbOutflowId(item.transactionId); setReimbInflowId(''); }} />
                              <span><strong>{item.descriptionOriginal}</strong><small>{item.occurredOn} · {item.accountName} · {formatBrlCents(item.amountCents)}</small></span>
                            </label>
                          ))}
                        </fieldset>
                        {reimbOutflowId && (() => {
                          const outflow = reimbCandidates.pjOutflows.find((item) => item.transactionId === reimbOutflowId);
                          const inflows = outflow ? compatibleInflows(reimbCandidates.pfInflows, outflow.occurredOn) : [];
                          return <fieldset className="reimb-options">
                            <legend>Entrada correspondente na conta PF</legend>
                            <label className="reimb-option">
                              <input type="radio" name="reimb-inflow" value="" checked={reimbInflowId === ''} onChange={() => setReimbInflowId('')} />
                              <span><strong>Sem entrada PF</strong></span>
                            </label>
                            {inflows.map((item) => (
                              <label key={item.transactionId} className="reimb-option">
                                <input type="radio" name="reimb-inflow" value={item.transactionId} checked={reimbInflowId === item.transactionId} onChange={() => setReimbInflowId(item.transactionId)} />
                                <span><strong>{item.descriptionOriginal}</strong><small>{item.occurredOn} · {item.accountName} · {formatBrlCents(item.amountCents)}</small></span>
                              </label>
                            ))}
                          </fieldset>;
                        })()}
                        <label className="field">
                          <span>Observação (opcional)</span>
                          <input type="text" maxLength={MAX_REIMBURSEMENT_NOTES} value={reimbNotes} onChange={(e) => setReimbNotes(e.target.value)} />
                        </label>
                      </>}
                    </>}
                    <div className="form-actions">
                      <button type="submit" className="btn btn-primary" disabled={!reimbOutflowId || busyAction !== null || dataStatus !== 'ready'}>{busyAction === 'reimbursement' ? 'Vinculando…' : 'Confirmar vínculo'}</button>
                      <button type="button" className="btn btn-outline" disabled={busyAction !== null} onClick={() => closeReimbursementPanel(true)}>Cancelar</button>
                    </div>
                  </form>}
                </section>}

                <details className="analysis-disclosure">
                  <summary>Ver análise do mês</summary>
                  {dataStatus === 'ready' && preview ? <>
                  <div className="summary-grid">
                    <article className="metric-cell"><span>Receita empresarial</span><strong className="mono">{formatBrlCents(preview.summary.businessRevenueTotalCents)}</strong><small>Receitas PF fora do total empresarial</small></article>
                    <article className="metric-cell"><span>Despesa empresarial</span><strong className="mono">{formatBrlCents(preview.summary.businessExpenseTotalCents)}</strong><small>PJ e despesas da empresa pagas por PF</small></article>
                    <article className="metric-cell"><span>Reembolsos liquidados</span><strong className="mono">{formatBrlCents(preview.summary.reimbursementsSettledInPeriodCents)}</strong></article>
                    <article className="metric-cell"><span>Pendências justificadas</span><strong className="mono">{preview.summary.justifiedCount}</strong></article>
                  </div>

                <div className="dual-tables">
                  <div tabIndex={0} role="region" aria-label="Tabela de fluxo de caixa por conta, rolável horizontalmente">
                    <h3 className="table-title">Fluxo de caixa por conta</h3>
                    <p className="scroll-hint">Deslize para ver todas as colunas →</p>
                    {(preview?.summary.cashFlowByAccount.length ?? 0) === 0 ? (
                      <p className="empty-hint">Sem movimentações para consolidar por conta neste mês.</p>
                    ) : (
                      <table className="ledger-table">
                        <thead>
                          <tr>
                            <th>Conta</th>
                            <th className="num">Entradas</th>
                            <th className="num">Saídas</th>
                            <th className="num">Líquido</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview!.summary.cashFlowByAccount.map((acc) => (
                            <tr key={acc.accountId}>
                              <td>
                                <span className={`account-tag tag-${acc.accountType.toLowerCase()}`}>
                                  {acc.accountType}
                                </span>
                                {acc.accountName}
                              </td>
                              <td className="num mono">{formatBrlCents(acc.inflowCents)}</td>
                              <td className="num mono">{formatBrlCents(acc.outflowCents)}</td>
                              <td className="num mono">{formatBrlCents(acc.netCents)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  <div tabIndex={0} role="region" aria-label="Tabela de totais por categoria, rolável horizontalmente">
                    <h3 className="table-title">Totais por categoria</h3>
                    <p className="scroll-hint">Deslize para ver todas as colunas →</p>
                    {(preview?.summary.categoryTotals.length ?? 0) === 0 ? (
                      <p className="empty-hint">Sem categorias movimentadas nesta competência.</p>
                    ) : (
                      <table className="ledger-table">
                        <thead>
                          <tr>
                            <th>Categoria</th>
                            <th className="num">Entradas</th>
                            <th className="num">Saídas</th>
                            <th className="num">Líquido</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview!.summary.categoryTotals.map((cat) => (
                            <tr key={cat.category}>
                              <td>
                                <strong>{cat.category}</strong>
                              </td>
                              <td className="num mono">{formatBrlCents(cat.inflowCents)}</td>
                              <td className="num mono">{formatBrlCents(cat.outflowCents)}</td>
                              <td className="num mono">{formatBrlCents(cat.netCents)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
                  </> : <p className="empty-hint">Análise disponível após carregar o mês.</p>}
                </details>

                {dataStatus === 'ready' && preview && <details className="analysis-disclosure">
                  <summary>Reembolsos do mês ({preview.reimbursementLinks.length})</summary>
                  {preview.reimbursementLinks.length === 0 ? <p className="empty-hint">Nenhum reembolso vinculado envolvendo este mês.</p> : <ul className="reimb-list">
                    {preview.reimbursementLinks.map((link) => (
                      <li key={link.reimbursementLinkId} className="reimb-item">
                        <div>
                          <span className="status-chip">{roleInPeriodLabel(link.roleInPeriod)}</span>
                          <strong className="mono">{formatBrlCents(link.amountCents)}</strong>
                        </div>
                        <dl>
                          <dt>Despesa PF</dt><dd>{describeTransaction(link.pfExpenseTransactionId)}</dd>
                          <dt>Saída PJ</dt><dd>{describeTransaction(link.pjReimbursementTransactionId)}</dd>
                          <dt>Entrada PF</dt><dd>{describeTransaction(link.pfInflowTransactionId)}</dd>
                        </dl>
                        <button type="button" className="btn btn-outline" disabled={busyAction !== null || dataStatus !== 'ready'} onClick={() => openReimbursementUnlink(link.reimbursementLinkId)}>Desfazer vínculo</button>
                      </li>
                    ))}
                  </ul>}
                </details>}

                {dataStatus === 'ready' && preview && preview.contextTransactions.length > 0 && <details className="analysis-disclosure">
                  <summary>Contexto de outros meses ({preview.contextTransactions.length})</summary>
                  <p className="context-note">Estes lançamentos aparecem só para explicar os vínculos de reembolso e não entram nos totais nem no CSV deste mês.</p>
                  <ul className="reimb-list">
                    {preview.contextTransactions.map((tx) => (
                      <li key={tx.transactionId} className="reimb-item">
                        <strong>{tx.descriptionOriginal}</strong>
                        <small>{tx.occurredOn} · [{tx.accountType}] {tx.accountName} · {tx.direction === 'SAIDA' ? '-' : '+'}{formatBrlCents(tx.amountCents)} · {reimbursementStatusLabel(tx.reimbursementStatus)}</small>
                      </li>
                    ))}
                  </ul>
                </details>}
              </section>}

              {/* 5. Movimentações principais e Pendências */}
              {activeSection === 'review' && <section className="ledger-sheet" aria-labelledby="heading-movements" ref={pendingSectionRef} tabIndex={-1}>
                <div className="sheet-header">
                  <div>
                    <h2 id="heading-movements">Pendências em aberto</h2>
                  </div>
                  {dataStatus === 'ready' && <span className="count-badge">{openPendings.length} em aberto</span>}
                </div>

                {dataStatus !== 'ready' ? <p className="empty-hint">{dataStatus === 'error' ? 'Não foi possível carregar as pendências. Atualize a visão.' : 'Carregando pendências…'}</p> : openPendings.length === 0 ? (
                  <p className="empty-hint">Sem pendências abertas na prévia deste mês.</p>
                ) : <ul className="pending-list">
                  {openPendings.map((item) => {
                    const tx = preview?.transactions.find((entry) => entry.transactionId === item.transactionId);
                    return <li key={item.pendingId} className="pending-row status-pendente">
                      <div><span className="pending-badge badge-pendente">Aberta</span><strong>{PENDING_TYPE_LABELS[item.pendingType]}</strong>
                        <p>{tx ? `${tx.descriptionOriginal} · ${tx.occurredOn} · ${formatBrlCents(tx.amountCents)}` : item.description}</p>
                        {tx && <small>{item.description}</small>}
                      </div>
                      <div className="pending-actions">
                        {item.pendingType === 'DOCUMENTO_AUSENTE' && <button type="button" className="btn btn-outline" onClick={() => chooseUploadTransaction(item.transactionId)}>Anexar comprovante <Icon name="arrow" /></button>}
                        {item.pendingType === 'REEMBOLSO_PF_PENDENTE' && <button type="button" className="btn btn-outline" disabled={busyAction !== null || dataStatus !== 'ready'} onClick={() => void openReimbursementLink(item.transactionId)}>Vincular reembolso <Icon name="arrow" /></button>}
                        {renderPendingActions(item)}
                      </div>
                    </li>;
                  })}
                </ul>}

                {txPanel && (() => {
                  const tx = preview?.transactions.find((item) => item.transactionId === txPanel.transactionId);
                  const linked = isTransactionLinked(txPanel.transactionId);
                  const locked = new Set<string>(lockedFieldsForLinked(linked));
                  const draftAccountType = accounts.find((account) => account.id === txDraft?.accountId)?.accountType;
                  const canSubmit = busyAction === null && dataStatus === 'ready';
                  return <section className="reimb-panel" role="dialog" aria-modal="false" aria-labelledby="heading-tx-panel" tabIndex={-1} ref={txPanelRef}
                    onKeyDown={(event) => { if (event.key === 'Escape' && busyAction === null) closeTransactionPanel(true); }}>
                    {!tx || !txDraft ? <>
                      <h3 id="heading-tx-panel">Lançamento indisponível</h3>
                      <p className="empty-hint">Este lançamento não está mais na visão do mês. Atualize a visão.</p>
                      <div className="form-actions"><button type="button" className="btn btn-outline" disabled={busyAction !== null} onClick={() => closeTransactionPanel(true)}>Fechar</button></div>
                    </> : txPanel.kind === 'delete' ? <>
                      <h3 id="heading-tx-panel">Excluir lançamento</h3>
                      <p className="reimb-expense"><strong>{tx.descriptionOriginal}</strong><span>{tx.occurredOn} · {tx.accountName} · {formatBrlCents(tx.amountCents)}</span></p>
                      <p>O lançamento sai da prévia e das próximas entregas. Documentos e entregas já capturadas são mantidos.</p>
                      {linked && <p className="context-note">Este lançamento participa de um reembolso. Desfaça o vínculo antes de excluí-lo.</p>}
                      {txPanelMessage && <p className="field-error" role="alert">{txPanelMessage.text}</p>}
                      <div className="form-actions">
                        <button type="button" className="btn btn-primary" disabled={linked || !canSubmit} onClick={handleConfirmTransactionDelete}>{busyAction === 'transaction-change' ? 'Excluindo…' : 'Confirmar exclusão'}</button>
                        <button type="button" className="btn btn-outline" disabled={busyAction !== null} onClick={() => closeTransactionPanel(true)}>Cancelar</button>
                      </div>
                    </> : <form onSubmit={handleSubmitTransactionEdit}>
                      <h3 id="heading-tx-panel">Corrigir lançamento</h3>
                      {linked && <p className="context-note">{LINKED_TRANSACTION_GUIDANCE}</p>}
                      <div className="form-row">
                        <label className="field field-grow">
                          <span>Conta da movimentação</span>
                          <select value={txDraft.accountId} disabled={locked.has('accountId') || tx.sourceType === 'CSV' || busyAction !== null} onChange={(e) => updateTxDraft({ accountId: e.target.value })}>
                            {accounts.filter((account) => account.active || account.id === tx.accountId).map((account) => (
                              <option key={account.id} value={account.id}>[{account.accountType}] {account.name}</option>
                            ))}
                          </select>
                          {tx.sourceType === 'CSV' && <small className="row-sub">Conta de lançamento importado não pode ser trocada.</small>}
                        </label>
                        <label className="field">
                          <span>Data civil</span>
                          <input type="date" required className="mono" value={txDraft.occurredOn} disabled={locked.has('occurredOn') || busyAction !== null} onChange={(e) => updateTxDraft({ occurredOn: e.target.value })} />
                        </label>
                      </div>
                      <div className="form-row">
                        <label className="field">
                          <span>Direção</span>
                          <select value={txDraft.direction} disabled={locked.has('direction') || busyAction !== null} onChange={(e) => updateTxDraft({ direction: e.target.value as Direction })}>
                            <option value="SAIDA">SAÍDA</option>
                            <option value="ENTRADA">ENTRADA</option>
                          </select>
                        </label>
                        <label className="field">
                          <span>Classificação</span>
                          <select value={txDraft.classification} disabled={locked.has('classification') || busyAction !== null} onChange={(e) => updateTxDraft({ classification: e.target.value as Classification })}>
                            {allowedClassifications(txDraft.direction).map((cls) => <option key={cls} value={cls}>{CLASSIFICATION_LABELS[cls]}</option>)}
                          </select>
                        </label>
                        <label className="field">
                          <span>Valor (BRL)</span>
                          <input type="text" required inputMode="decimal" className="mono" value={txDraft.amountInput} disabled={locked.has('amountCents') || busyAction !== null} onChange={(e) => updateTxDraft({ amountInput: e.target.value })} />
                        </label>
                      </div>
                      <div className="form-row">
                        <label className="field">
                          <span>Categoria</span>
                          <input type="text" required maxLength={100} value={txDraft.category} disabled={busyAction !== null} onChange={(e) => updateTxDraft({ category: e.target.value })} />
                        </label>
                        <label className="field field-grow">
                          <span>Descrição da operação</span>
                          <input type="text" required maxLength={500} value={txDraft.description} disabled={busyAction !== null} onChange={(e) => updateTxDraft({ description: e.target.value })} />
                        </label>
                      </div>
                      <label className="checkbox-field">
                        <input type="checkbox" checked={txDraft.isPfBusinessExpense}
                          disabled={locked.has('isPfBusinessExpense') || busyAction !== null || !canMarkPfBusinessExpense(draftAccountType, txDraft.direction, txDraft.classification)}
                          onChange={(e) => updateTxDraft({ isPfBusinessExpense: e.target.checked })} />
                        <span>Despesa empresarial paga em conta PF</span>
                      </label>
                      <label className="field">
                        <span>Explicação complementar (opcional)</span>
                        <input type="text" maxLength={2000} value={txDraft.explanation} disabled={busyAction !== null} onChange={(e) => updateTxDraft({ explanation: e.target.value })} />
                      </label>
                      {txPanelMessage && <p className={txPanelMessage.tone === 'err' ? 'field-error' : 'context-note'} role={txPanelMessage.tone === 'err' ? 'alert' : 'status'}>{txPanelMessage.text}</p>}
                      <div className="form-actions">
                        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>{busyAction === 'transaction-change' ? 'Gravando…' : 'Salvar correção'}</button>
                        <button type="button" className="btn btn-outline" disabled={busyAction !== null} onClick={() => closeTransactionPanel(true)}>Cancelar</button>
                      </div>
                    </form>}
                  </section>;
                })()}

                {pendingPanel && (() => {
                  const canSubmit = busyAction === null && dataStatus === 'ready';
                  const closeButton = <button type="button" className="btn btn-outline" disabled={busyAction !== null} onClick={() => closePendingPanel(true)}>Cancelar</button>;
                  const shell = (children: ReactNode) => <section className="reimb-panel" role="dialog" aria-modal="false" aria-labelledby="heading-pending-panel" tabIndex={-1} ref={pendingPanelRef}
                    onKeyDown={(event) => { if (event.key === 'Escape' && busyAction === null) closePendingPanel(true); }}>{children}</section>;
                  const unavailable = (title: string, text: string, extra?: ReactNode) => shell(<>
                    <h3 id="heading-pending-panel">{title}</h3>
                    {extra}
                    <p className="empty-hint">{text}</p>
                    <div className="form-actions"><button type="button" className="btn btn-outline" disabled={busyAction !== null} onClick={() => closePendingPanel(true)}>Fechar</button></div>
                  </>);
                  const textTooLong = pendingText.trim().length > 2000;
                  const textField = (label: string) => <div className="field">
                    <label htmlFor="pending-text">{label}</label>
                    <textarea id="pending-text" value={pendingText} disabled={busyAction !== null} aria-invalid={textTooLong} aria-describedby="pending-char-count" onChange={(e) => { setPendingPanelMessage(null); setPendingText(e.target.value); }} />
                    <small className={textTooLong ? 'char-count char-count-over mono' : 'char-count mono'} id="pending-char-count">{pendingText.trim().length} / 2.000</small>
                  </div>;
                  const message = pendingPanelMessage && <p className={pendingPanelMessage.tone === 'err' ? 'field-error' : 'context-note'} role={pendingPanelMessage.tone === 'err' ? 'alert' : 'status'}>{pendingPanelMessage.text}</p>;
                  if (pendingPanel.kind === 'create') {
                    const tx = preview?.transactions.find((entry) => entry.transactionId === pendingPanel.transactionId);
                    if (!tx || !preview) return unavailable('Lançamento indisponível', 'Este lançamento não está mais na visão do mês. Atualize a visão.');
                    if (hasQuestion(preview.pendingItems, tx.transactionId)) return unavailable('Dúvida já registrada', 'Este lançamento já tem uma dúvida. Edite ou reabra a dúvida existente.');
                    return shell(<form onSubmit={handleSubmitPendingPanel}>
                      <h3 id="heading-pending-panel">Registrar dúvida</h3>
                      <p className="reimb-expense"><strong>{tx.descriptionOriginal}</strong><span>{tx.occurredOn} · {tx.accountName} · {formatBrlCents(tx.amountCents)}</span></p>
                      {textField('Dúvida sobre este lançamento')}
                      {message}
                      <div className="form-actions">
                        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>{busyAction === 'pending-change' ? 'Gravando…' : 'Registrar dúvida'}</button>
                        {closeButton}
                      </div>
                    </form>);
                  }
                  const item = preview?.pendingItems.find((entry) => entry.pendingId === pendingPanel.pendingId);
                  if (!item) return unavailable('Pendência indisponível', 'Esta pendência não está mais na visão do mês. Atualize a visão.');
                  const tx = preview?.transactions.find((entry) => entry.transactionId === item.transactionId);
                  const allowed = allowedPendingActions(item);
                  const summary = <p className="reimb-expense">
                    <strong>{PENDING_TYPE_LABELS[item.pendingType]} · {PENDING_STATUS_LABELS[item.status]}</strong>
                    <span>{tx ? `${tx.descriptionOriginal} · ${tx.occurredOn} · ${formatBrlCents(tx.amountCents)}` : 'Lançamento fora da visão carregada'}</span>
                    <span>{item.description}</span>
                    {item.justification && <span>Justificativa: {item.justification}</span>}
                  </p>;
                  if (pendingPanel.kind === 'manage') {
                    return shell(<>
                      <h3 id="heading-pending-panel">Dúvida registrada</h3>
                      {summary}
                      {allowed.length === 0 && <p className="empty-hint">Nenhuma ação disponível para esta pendência.</p>}
                      <div className="form-actions">
                        {allowed.map((entry) => <button key={entry} type="button" className="btn btn-outline" disabled={!canSubmit} onClick={() => switchPendingPanel(PENDING_ACTION_PANEL[entry], item.pendingId)}>{PENDING_ACTION_LABELS[entry]}</button>)}
                        <button type="button" className="btn btn-outline" disabled={busyAction !== null} onClick={() => closePendingPanel(true)}>Fechar</button>
                      </div>
                    </>);
                  }
                  const action = PENDING_PANEL_ACTION[pendingPanel.kind];
                  if (!allowed.includes(action)) return unavailable('Ação indisponível', 'O estado desta pendência mudou e a ação não está mais disponível. Atualize a visão.', summary);
                  return shell(<form onSubmit={handleSubmitPendingPanel}>
                    <h3 id="heading-pending-panel">{action === 'JUSTIFY' ? 'Justificar pendência' : action === 'EDIT' ? 'Editar texto da dúvida' : action === 'RESOLVE' ? 'Resolver dúvida' : 'Reabrir dúvida'}</h3>
                    {summary}
                    {action === 'JUSTIFY' && <>
                      <p className="context-note">{JUSTIFICATION_DISCLAIMER}</p>
                      {textField('Justificativa')}
                    </>}
                    {action === 'EDIT' && textField('Texto da dúvida')}
                    {action === 'RESOLVE' && <p>A dúvida passa a resolvida e deixa de contar como pendência em aberto. A justificativa registrada é mantida.</p>}
                    {action === 'REOPEN' && <p className="context-note">Ao reabrir, a dúvida volta a ficar em aberto e a justificativa registrada é apagada.</p>}
                    {message}
                    <div className="form-actions">
                      <button type="submit" className="btn btn-primary" disabled={!canSubmit}>{busyAction === 'pending-change' ? 'Gravando…' : action === 'JUSTIFY' ? 'Registrar justificativa' : action === 'EDIT' ? 'Salvar texto' : action === 'RESOLVE' ? 'Confirmar: resolver' : 'Confirmar: reabrir'}</button>
                      {closeButton}
                    </div>
                  </form>);
                })()}

                {documentPanel && (() => {
                  const canSubmit = busyAction === null && dataStatus === 'ready';
                  const tx = preview?.transactions.find((entry) => entry.transactionId === documentPanel.transactionId);
                  const doc = documentPanel.kind === 'link' ? undefined : documents.find((entry) => entry.documentId === documentPanel.documentId);
                  const linkable = documentPanel.kind === 'link' ? linkableDocuments(documents, documentPanel.transactionId) : [];
                  const title = documentPanel.kind === 'replace' ? 'Substituir documento' : documentPanel.kind === 'unlink' ? 'Desvincular documento' : 'Vincular documento do mês';
                  const shell = (children: ReactNode) => <section className="reimb-panel" role="dialog" aria-modal="false" aria-labelledby="heading-document-panel" tabIndex={-1} ref={documentPanelRef}
                    onKeyDown={(event) => { if (event.key === 'Escape' && busyAction === null) closeDocumentPanel(true); }}>{children}</section>;
                  const closeButton = <button type="button" className="btn btn-outline" disabled={busyAction !== null} onClick={() => closeDocumentPanel(true)}>Cancelar</button>;
                  if (!tx || (documentPanel.kind !== 'link' && !doc)) {
                    return shell(<>
                      <h3 id="heading-document-panel">Documento indisponível</h3>
                      <p className="empty-hint">O lançamento ou o documento não está mais na visão do mês. Atualize a visão.</p>
                      <div className="form-actions"><button type="button" className="btn btn-outline" disabled={busyAction !== null} onClick={() => closeDocumentPanel(true)}>Fechar</button></div>
                    </>);
                  }
                  return shell(<form onSubmit={handleSubmitDocumentPanel}>
                    <h3 id="heading-document-panel">{title}</h3>
                    <p className="reimb-expense">
                      <strong>{tx.descriptionOriginal}</strong>
                      <span>{tx.occurredOn} · {tx.accountName} · {formatBrlCents(tx.amountCents)}</span>
                      {doc && <span>Documento: {doc.originalName} · {formatFileSize(doc.sizeBytes)}</span>}
                    </p>
                    {documentPanel.kind === 'replace' && <>
                      <p className="context-note">O arquivo anterior continua guardado; entregas já capturadas não mudam.</p>
                      <div className="field">
                        <label htmlFor="document-panel-file">Novo arquivo (PDF, PNG ou JPEG, até 5 MiB)</label>
                        <input id="document-panel-file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" disabled={busyAction !== null} aria-invalid={documentPanelFileError !== null}
                          onChange={(e) => chooseReplacementFile(e.target.files?.[0] ?? null)} />
                        {documentPanelFileError && <p className="field-error" role="alert">{documentPanelFileError}</p>}
                      </div>
                    </>}
                    {documentPanel.kind === 'unlink' && <p className="context-note">O documento não é apagado. Se o lançamento ficar sem comprovante, a pendência de comprovante ausente volta.</p>}
                    {documentPanel.kind === 'link' && (linkable.length === 0
                      ? <p className="empty-hint">Nenhum outro documento do mês está disponível para este lançamento.</p>
                      : <div className="field">
                        <label htmlFor="document-panel-link">Documento do mês</label>
                        <select id="document-panel-link" value={documentLinkId} disabled={busyAction !== null} onChange={(e) => { setDocumentPanelMessage(null); setDocumentLinkId(e.target.value); }}>
                          <option value="">Selecione um documento</option>
                          {linkable.map((entry) => <option key={entry.documentId} value={entry.documentId}>{entry.originalName} ({formatFileSize(entry.sizeBytes)})</option>)}
                        </select>
                      </div>)}
                    {documentPanelMessage && <p className="field-error" role="alert">{documentPanelMessage}</p>}
                    <div className="form-actions">
                      <button type="submit" className="btn btn-primary" disabled={!canSubmit || (documentPanel.kind === 'replace' && (!documentPanelFile || documentPanelFileError !== null)) || (documentPanel.kind === 'link' && !documentLinkId)}>
                        {busyAction === 'document-change' ? 'Gravando…' : documentPanel.kind === 'replace' ? 'Substituir documento' : documentPanel.kind === 'unlink' ? 'Confirmar: desvincular' : 'Vincular documento'}
                      </button>
                      {closeButton}
                    </div>
                  </form>);
                })()}

                <details className="secondary-disclosure"><summary>Ver todos os lançamentos ({preview?.transactions.length ?? 0})</summary>

                {dataStatus !== 'ready' ? <p className="empty-hint">Carregue o mês para ver os lançamentos.</p> : (preview?.transactions.length ?? 0) === 0 ? (
                  <p className="empty-hint">
                    Nenhuma movimentação registrada em {periodMonth}. Abra Lançamentos para registrar a primeira operação.
                  </p>
                ) : (
                  <div className="table-scroll" tabIndex={0} role="region" aria-label="Tabela de movimentações, rolável horizontalmente">
                    <table className="ledger-table">
                      <thead>
                        <tr>
                          <th>Data</th>
                          <th>Conta</th>
                          <th>Descrição e categoria</th>
                          <th>Classificação</th>
                          <th className="num">Valor</th>
                          <th>Comprovantes</th>
                          <th>Ações</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview!.transactions.map((tx) => (
                          <tr key={tx.transactionId} className={docTransactionId === tx.transactionId ? 'is-selected' : ''}>
                            <td className="mono">{tx.occurredOn}</td>
                            <td>
                              <span className={`account-tag tag-${tx.accountType.toLowerCase()}`}>{tx.accountType}</span>
                              {tx.accountName}
                            </td>
                            <td>
                              <strong>{tx.descriptionOriginal}</strong>
                              <div className="row-sub">
                                Categoria: {tx.categoryOriginal}
                                {tx.isPfBusinessExpense ? ' · Despesa PF da empresa' : ''}
                              </div>
                            </td>
                            <td>
                              <span className="status-chip">{CLASSIFICATION_LABELS[tx.classification]}</span>
                              {tx.reimbursementStatus !== 'NAO_APLICAVEL' && <div className="row-sub">{reimbursementStatusLabel(tx.reimbursementStatus)}</div>}
                            </td>
                            <td className="num mono">
                              {tx.direction === 'SAIDA' ? '-' : '+'}
                              {formatBrlCents(tx.amountCents)}
                            </td>
                            <td>
                              <span className="mono">{documentsByTx.get(tx.transactionId)?.length ?? 0} anexo(s)</span>
                              {(documentsByTx.get(tx.transactionId)?.length ?? 0) > 0 && <ul className="doc-list">
                                {documentsByTx.get(tx.transactionId)!.map((doc) => <li key={doc.documentId} className="doc-item">
                                  <span className="doc-name">{doc.originalName}</span>
                                  <span className="doc-meta">{DOCUMENT_TYPE_LABELS[doc.mimeType] ?? doc.mimeType} · {formatFileSize(doc.sizeBytes)}</span>
                                  <div className="row-actions">
                                    <a className="btn-link" href={`/api/v1/documents/${encodeURIComponent(doc.documentId)}/content`} download>Baixar</a>
                                    <button type="button" className="btn-link" disabled={busyAction !== null || dataStatus !== 'ready'} onClick={() => openDocumentPanel({ kind: 'replace', transactionId: tx.transactionId, documentId: doc.documentId })}>Substituir</button>
                                    <button type="button" className="btn-link" disabled={busyAction !== null || dataStatus !== 'ready'} onClick={() => openDocumentPanel({ kind: 'unlink', transactionId: tx.transactionId, documentId: doc.documentId })}>Desvincular</button>
                                  </div>
                                </li>)}
                              </ul>}
                              <div>
                                <button
                                  type="button"
                                  className="btn-link"
                                  onClick={() => {
                                    chooseUploadTransaction(tx.transactionId);
                                  }}
                                >
                                  Selecionar p/ upload
                                </button>
                              </div>
                              {linkableDocuments(documents, tx.transactionId).length > 0 && <div>
                                <button type="button" className="btn-link" disabled={busyAction !== null || dataStatus !== 'ready'} onClick={() => openDocumentPanel({ kind: 'link', transactionId: tx.transactionId })}>Vincular documento do mês</button>
                              </div>}
                              {tx.reimbursementStatus === 'PENDENTE_REEMBOLSO' && <div>
                                <button type="button" className="btn-link" disabled={busyAction !== null || dataStatus !== 'ready'} onClick={() => void openReimbursementLink(tx.transactionId)}>Vincular reembolso</button>
                              </div>}
                            </td>
                            <td>
                              <div className="row-actions">
                                <button type="button" className="btn-link" disabled={busyAction !== null || dataStatus !== 'ready'} onClick={() => openTransactionPanel('edit', tx)}>Corrigir</button>
                                <button type="button" className="btn-link" disabled={busyAction !== null || dataStatus !== 'ready'} onClick={() => openTransactionPanel('delete', tx)}>Excluir</button>
                                {(() => {
                                  const question = preview!.pendingItems.find((entry) => entry.transactionId === tx.transactionId && entry.pendingType === 'DUVIDA_CADASTRADA');
                                  return question
                                    ? <button type="button" className="btn-link" disabled={busyAction !== null || dataStatus !== 'ready'} onClick={() => openPendingPanel({ kind: 'manage', pendingId: question.pendingId })}>Dúvida: {PENDING_STATUS_LABELS[question.status].toLowerCase()}</button>
                                    : <button type="button" className="btn-link" disabled={busyAction !== null || dataStatus !== 'ready'} onClick={() => openPendingPanel({ kind: 'create', transactionId: tx.transactionId })}>Registrar dúvida</button>;
                                })()}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                </details>
                {otherPendings.length > 0 && <details className="secondary-disclosure"><summary>Ver itens justificados ou resolvidos ({otherPendings.length})</summary><ul className="pending-list">{otherPendings.map((item) => <li key={item.pendingId} className="pending-row"><div><span className={`pending-badge badge-${item.status.toLowerCase()}`}>{item.status}</span><span>{PENDING_TYPE_LABELS[item.pendingType]} · {item.description}</span>{item.justification && <p className="pending-note">Justificativa: {item.justification}</p>}</div><div className="pending-actions">{renderPendingActions(item)}</div></li>)}</ul></details>}
              </section>}

              {/* 6. Captura Imutável, Executor e Downloads (I07 + I08 + I09) */}
              {activeSection === 'deliveries' && <section className="ledger-sheet" aria-labelledby="heading-deliveries">
                <div className="sheet-header">
                  <div>
                    <span className="section-kicker">Fechamento para contabilidade externa</span>
                    <h2 id="heading-deliveries">Versões e pacote auditável</h2>
                  </div>
                  {dataStatus === 'ready' && <span className="count-badge mono">{deliveries.length} versão(ões)</span>}
                </div>
                {dataStatus === 'ready' && requiresRectification && <p className="context-note"><strong>Próxima versão: v{deliveries.length + 1}.</strong> Registre o motivo da retificação para manter a trilha de versões compreensível.</p>}
                {dataStatus === 'ready' && latestDelivery?.status === 'PRONTA' && preview && latestDelivery.capturedRevision !== preview.revision && <p className="context-note">A entrega v{latestDelivery.versionNumber} preserva a revisão #{latestDelivery.capturedRevision}. O acervo está na revisão #{preview.revision}; uma nova entrega inclui as alterações recentes.</p>}

                <form className="ledger-form" onSubmit={(e) => void handleCaptureDelivery(e)}>
                  <details className="secondary-disclosure"><summary>Opções avançadas da operação</summary><div className="form-row">
                    <label className="field field-grow">
                      <span>Chave da operação (gerada automaticamente)</span>
                      <input
                        type="text"
                        required
                        minLength={16}
                        maxLength={128}
                        value={idempotencyKey}
                        onChange={(e) => setIdempotencyKey(e.target.value)}
                        className="mono"
                      />
                    </label>
                    <div className="field field-button-align">
                      <button
                        type="button"
                        className="btn btn-outline"
                        onClick={() => setIdempotencyKey(generateIdempotencyKey())}
                      >
                        Nova chave
                      </button>
                    </div>
                  </div></details>

                  <label className="field">
                    <span>
                      Motivo de retificação{' '}
                      {requiresRectification ? '(obrigatório a partir da v2 — mín. 3 caracteres)' : '(vazio na v1)'}
                    </span>
                    <input
                      type="text"
                      maxLength={1000}
                      required={requiresRectification}
                      placeholder={
                        requiresRectification
                          ? 'Descreva o motivo da nova versão para a contabilidade'
                          : 'Primeira entrega do mês não exige motivo de retificação'
                      }
                      value={rectificationReason}
                      onChange={(e) => setRectificationReason(e.target.value)}
                    />
                  </label>

                  <div className="form-actions">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={(preview?.transactions.length ?? 0) === 0 || busyAction !== null || dataStatus !== 'ready'}
                    >
                      {busyAction === 'capture'
                        ? 'Preparando entrega…'
                        : `Capturar entrega de ${periodMonth} (rev. #${session.revision})`}
                    </button>
                  </div>
                </form>

                {dataStatus !== 'ready' ? <p className="empty-hint">{dataStatus === 'error' ? 'Não foi possível carregar as versões. Atualize a visão.' : 'Carregando versões…'}</p> : deliveries.length === 0 ? (
                  <p className="empty-hint">
                    Nenhuma entrega preparada para {periodMonth}. Ao fechar, o conteúdo do mês fica preservado em uma nova versão.
                  </p>
                ) : (
                  <div className="deliveries-list">
                    {deliveries.length > 1 && <button type="button" className="btn-link older-toggle" aria-expanded={showOlderDeliveries} onClick={() => setShowOlderDeliveries((value) => !value)}>{showOlderDeliveries ? 'Ocultar versões anteriores' : `Ver ${deliveries.length - 1} versão(ões) anterior(es)`}</button>}
                    {[...deliveries].reverse().map((op, index) => (index === 0 || showOlderDeliveries) && (
                      <article key={op.id} className={`delivery-card op-${op.status.toLowerCase()}`}>
                        <div className="delivery-top">
                          <div>
                            <strong className="mono">
                              {op.periodMonth} · v{op.versionNumber}
                            </strong>
                            <span className={`op-badge badge-${op.status.toLowerCase()}`}>{op.status}</span>
                          </div>
                          <span className="mono uuid-short">
                            rev. #{op.capturedRevision} · tentativas: {op.attemptCount}
                          </span>
                        </div>

                        <details className="delivery-identifiers"><summary>Identificadores de auditoria</summary><div className="delivery-ids mono"><span>Captura: {op.snapshotId}</span><span>Operação: {op.id}</span></div></details>

                        {op.status === 'PRONTA' ? (
                          <div className="delivery-downloads">
                            <div className="download-links">
                              <a
                                className="btn btn-primary"
                                href={`/api/v1/deliveries/${encodeURIComponent(op.snapshotId)}/package`}
                                download={`entrega-${op.periodMonth}-v${op.versionNumber}.zip`}
                              >
                                Baixar pacote ZIP (v{op.versionNumber})
                              </a>
                              <a
                                className="btn btn-outline"
                                href={`/api/v1/deliveries/${encodeURIComponent(op.snapshotId)}/manifest`}
                                download={`entrega-${op.periodMonth}-v${op.versionNumber}.manifesto.json`}
                              >
                                Baixar manifesto de referência v2
                              </a>
                            </div>
                            <div className="verifier-box">
                              <span>Para conferir o pacote de forma independente, use este comando no terminal:</span>
                              <code className="mono">
                                {buildVerifierCommand(op.periodMonth, op.versionNumber)}
                              </code>
                              <button type="button" className="btn btn-outline" onClick={() => void copyVerifierCommand(op)}>{copiedOperationId === op.id ? 'Copiado!' : 'Copiar comando CLI'}</button>
                            </div>
                          </div>
                        ) : op.status === 'FALHA' ? (
                          <p className="delivery-error">
                            Operação encerrada em falha terminal ({op.errorCode ?? 'FALHA'}). Gere uma nova chave idempotente para capturar a próxima versão.
                          </p>
                        ) : (
                          <p className="delivery-progress">
                            Preparando os arquivos da entrega. O status é atualizado automaticamente…
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </section>}
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
