export type Direction = 'ENTRADA' | 'SAIDA';
export type Classification = 'RECEITA' | 'DESPESA' | 'TRANSFERENCIA' | 'A_ESCLARECER';
export type AccountType = 'PF' | 'PJ';

export function parseBrlCents(raw: string): number | null;
export function validateDocumentFile(file: Pick<File, 'name' | 'type' | 'size'> | null): string | null;
export function attemptLogout(
  csrfToken: string,
  request?: (url: string, options: RequestInit) => Promise<Pick<Response, 'status' | 'ok'>>
): Promise<{ ended: boolean; confirmed: boolean }>;
export function formatBrlCents(cents: number): string;
export function allowedClassifications(direction: Direction): Classification[];
export function canMarkPfBusinessExpense(
  accountType: AccountType | undefined,
  direction: Direction,
  classification: Classification
): boolean;
export function isValidPeriodMonth(month: string): boolean;
export function shiftPeriodMonth(month: string, deltaMonths: number): string;
export function defaultDateForMonth(month: string, currentDate: string): string;
export function nextVersionRequiresReason(historyItems: readonly { versionNumber: number }[]): boolean;
export function nextMonthAction(input: {
  loaded: boolean;
  accounts: readonly { id: string }[];
  preview: { revision: number; transactions: readonly { transactionId: string }[]; pendingItems: readonly { transactionId: string; pendingType: string; status: string }[] } | null;
  deliveries: readonly { versionNumber: number; status: string; capturedRevision: number }[];
}): { kind: 'loading' | 'accounts' | 'transactions' | 'review' | 'capture' | 'delivery' } | { kind: 'document' | 'reimbursement' | 'question'; transactionId: string };
export function reimbursementStatusLabel(status: string): string;
export function roleInPeriodLabel(role: string): string;
export function compatibleInflows<T extends { occurredOn: string }>(inflows: readonly T[], outflowDate: string): T[];
export function generateIdempotencyKey(): string;
export function buildVerifierCommand(periodMonth: string, versionNumber: number): string;
export function describePendingError(status: number, payload: unknown): { code: string; message: string; requestId: string | null };
export function describeApiError(
  status: number,
  payload: unknown
): { code: string; message: string; requestId: string | null };
export type TransactionEditableFields = {
  accountId: string;
  occurredOn: string;
  direction: Direction;
  amountCents: number;
  description: string;
  category: string;
  classification: Classification;
  isPfBusinessExpense: boolean;
  explanation: string;
};
export function buildTransactionPatch(
  original: TransactionEditableFields,
  draft: TransactionEditableFields
): Partial<TransactionEditableFields> | null;
export function lockedFieldsForLinked(isLinked: boolean): (keyof TransactionEditableFields)[];
export type PendingAction = 'JUSTIFY' | 'RESOLVE' | 'REOPEN' | 'EDIT';
export function validatePendingText(text: unknown): { value: string; error: string | null };
export function allowedPendingActions(item: { pendingType: string; status: string } | null): PendingAction[];
export function hasQuestion(pendingItems: readonly { transactionId: string; pendingType: string }[], transactionId: string): boolean;
export function documentsByTransaction<T extends { transactionIds: readonly string[] }>(documents: readonly T[]): Map<string, T[]>;
export function linkableDocuments<T extends { transactionIds: readonly string[] }>(documents: readonly T[], transactionId: string): T[];
export function formatFileSize(bytes: number): string;
export function describeDocumentError(status: number, payload: unknown): { code: string; message: string; requestId: string | null };
export type ImportTotals = { rows: number; new: number; ignored: number; repeated: number; conflicting: number; invalid: number };
export function validateImportFile(file: Pick<File, 'name' | 'size'> | null): string | null;
export function importReady(preview: { totals: ImportTotals } | null): boolean;
export function importStatusLabel(status: string): string;
export function importReasonLabel(code: string): string;
export function describeImportError(status: number, payload: unknown): { code: string; message: string; requestId: string | null };
