import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  allowedClassifications,
  attemptLogout,
  buildVerifierCommand,
  canMarkPfBusinessExpense,
  defaultDateForMonth,
  describeApiError,
  formatBrlCents,
  generateIdempotencyKey,
  isValidPeriodMonth,
  nextVersionRequiresReason,
  nextMonthAction,
  parseBrlCents,
  reimbursementStatusLabel,
  roleInPeriodLabel,
  compatibleInflows,
  shiftPeriodMonth,
  validateDocumentFile,
} from './ledger.mjs';
import type { AccountType, Classification, Direction } from './ledger.mjs';

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
    try {
      [accPage, prevRes, delPage] = await Promise.all([
        fetchAllPages<AccountItem>('/api/v1/accounts', 200),
        fetch(`/api/v1/periods/${encodeURIComponent(month)}/preview`, { credentials: 'same-origin' }),
        fetchAllPages<DeliveryOperation>(`/api/v1/periods/${encodeURIComponent(month)}/deliveries`, 200),
      ]);
    } catch {
      if (sequence === loadSequence.current) {
        setDataStatus('error');
        setNotice({ tone: 'err', title: 'Falha de conexão', detail: 'Não foi possível atualizar o caderno. Tente novamente.' });
      }
      return;
    }
    if (sequence !== loadSequence.current) return;

    if (accPage.status === 401 || prevRes.status === 401 || delPage.status === 401) {
      closeReimbursementPanel();
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

    if (delPage.status === 200) {
      setDeliveries(delPage.items);
      const latest = delPage.items[delPage.items.length - 1] ?? null;
      setActiveOperation(latest);
    }
    if (accPage.status !== 200 || !prevRes.ok || delPage.status !== 200) {
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
    if (!session) closeReimbursementPanel();
  }, [session]);

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
    setPeriodMonth(nextMonth);
    setPreview(null);
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
      setNotice({ tone: 'ok', title: okTitle, detail: `Alteração gravada na revisão #${body.revision}.` });
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

  function describeTransaction(transactionId: string | null) {
    if (!transactionId || !preview) return 'Não informada';
    const tx = [...preview.transactions, ...preview.contextTransactions].find((item) => item.transactionId === transactionId);
    return tx ? `${tx.descriptionOriginal} · ${tx.occurredOn} · ${formatBrlCents(tx.amountCents)}` : 'Lançamento fora da visão carregada';
  }

  const requiresRectification = nextVersionRequiresReason(deliveries);
  const nextAction = nextMonthAction({ loaded: dataStatus === 'ready', accounts, preview, deliveries });
  const latestDelivery = deliveries.reduce<DeliveryOperation | null>((latest, item) => !latest || item.versionNumber > latest.versionNumber ? item : latest, null);
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
      case 'review': return { title: 'Confira as pendências', detail: 'Confira estes itens. Eles continuarão registrados na entrega.', button: 'Ver pendências' };
      case 'capture': return { title: latestDelivery?.status === 'FALHA' ? 'Prepare uma nova entrega' : latestDelivery ? 'O acervo mudou desde a última entrega' : 'Pronto para preparar a entrega', detail: latestDelivery?.status === 'FALHA' ? 'A última operação falhou. Uma nova captura gera outra versão.' : latestDelivery ? 'A versão anterior preserva a revisão capturada. Prepare uma nova versão para incluir alterações recentes.' : 'Os lançamentos do mês podem ser preservados em um pacote auditável.', button: 'Abrir entregas' };
      case 'delivery': return { title: latestDelivery?.status === 'PRONTA' ? `Entrega v${latestDelivery.versionNumber} disponível` : `Entrega v${latestDelivery?.versionNumber ?? ''} em preparo`, detail: latestDelivery?.status === 'PRONTA' ? 'Baixe o pacote e o manifesto para conferência independente.' : 'Acompanhe a preparação do pacote; o status atualiza automaticamente.', button: 'Ver entrega' };
      default: return { title: dataStatus === 'error' ? 'Não foi possível carregar o mês' : 'Carregando o mês', detail: dataStatus === 'error' ? 'Atualize a visão para decidir o próximo passo com dados completos.' : 'Aguarde a prévia e o histórico de entregas.', button: 'Atualizar visão' };
    }
  })();

  function openNextAction() {
    if (nextAction.kind === 'document') { chooseUploadTransaction(nextAction.transactionId); return; }
    if (nextAction.kind === 'reimbursement') { void openReimbursementLink(nextAction.transactionId); return; }
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
                  <button type="button" className="btn btn-primary" disabled={busyAction !== null || (nextAction.kind === 'reimbursement' && dataStatus !== 'ready')} onClick={openNextAction}>{nextActionContent.button} <Icon name="arrow" /></button>
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
                      {item.pendingType === 'DOCUMENTO_AUSENTE' ? <button type="button" className="btn btn-outline" onClick={() => chooseUploadTransaction(item.transactionId)}>Anexar comprovante <Icon name="arrow" /></button> : item.pendingType === 'REEMBOLSO_PF_PENDENTE' ? <button type="button" className="btn btn-outline" disabled={busyAction !== null || dataStatus !== 'ready'} onClick={() => void openReimbursementLink(item.transactionId)}>Vincular reembolso <Icon name="arrow" /></button> : <span className="pending-guidance">Acompanhar na entrega</span>}
                    </li>;
                  })}
                </ul>}

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
                              <span className="mono">{tx.documentIds.length} anexo(s)</span>
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
                              {tx.reimbursementStatus === 'PENDENTE_REEMBOLSO' && <div>
                                <button type="button" className="btn-link" disabled={busyAction !== null || dataStatus !== 'ready'} onClick={() => void openReimbursementLink(tx.transactionId)}>Vincular reembolso</button>
                              </div>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                </details>
                {otherPendings.length > 0 && <details className="secondary-disclosure"><summary>Ver itens justificados ou resolvidos ({otherPendings.length})</summary><ul className="pending-list">{otherPendings.map((item) => <li key={item.pendingId} className="pending-row"><span className={`pending-badge badge-${item.status.toLowerCase()}`}>{item.status}</span><span>{PENDING_TYPE_LABELS[item.pendingType]} · {item.description}</span></li>)}</ul></details>}
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
