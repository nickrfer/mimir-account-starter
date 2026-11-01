const MAX_TRANSACTION_CENTS = 99_999_999_999;

export function parseBrlCents(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^R\$\s*/i, '').trim();
  if (!cleaned || cleaned.startsWith('-') || cleaned.startsWith('+')) return null;

  let integerPart = '';
  let fractionPart = '00';

  if (cleaned.includes(',')) {
    const parts = cleaned.split(',');
    if (parts.length !== 2) return null;
    if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(parts[0]) || /^0\d+\./.test(parts[0])) return null;
    integerPart = parts[0].replace(/\./g, '');
    const frac = parts[1];
    if (!/^\d{1,2}$/.test(frac)) return null;
    fractionPart = frac.padEnd(2, '0');
  } else if (cleaned.includes('.')) {
    const parts = cleaned.split('.');
    if (parts.length === 2 && parts[1].length <= 2) {
      integerPart = parts[0];
      if (!/^\d{1,2}$/.test(parts[1])) return null;
      fractionPart = parts[1].padEnd(2, '0');
    } else {
      return null;
    }
  } else {
    integerPart = cleaned;
  }

  if (!/^\d+$/.test(integerPart) || integerPart.length > 10) return null;
  const cents = BigInt(integerPart) * 100n + BigInt(fractionPart);
  if (cents < 1n || cents > BigInt(MAX_TRANSACTION_CENTS)) return null;
  return Number(cents);
}

export function validateDocumentFile(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) return 'O arquivo está vazio ou inválido.';
  if (file.size > 5 * 1024 * 1024) return 'O comprovante deve ter no máximo 5 MiB.';
  const extension = String(file.name).split('.').at(-1)?.toLowerCase();
  const types = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
  if (!extension || !Object.hasOwn(types, extension) || file.type !== types[extension]) {
    return 'Use um arquivo PDF, PNG ou JPEG.';
  }
  return null;
}

export async function attemptLogout(csrfToken, request = globalThis.fetch) {
  try {
    const response = await request('/api/v1/session', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    return { ended: response.ok || response.status === 401, confirmed: response.ok };
  } catch {
    return { ended: false, confirmed: false };
  }
}

export function formatBrlCents(cents) {
  if (!Number.isSafeInteger(cents)) return 'R$ 0,00';
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const formattedWhole = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}R$ ${formattedWhole},${frac}`;
}

export function allowedClassifications(direction) {
  return direction === 'ENTRADA'
    ? ['RECEITA', 'TRANSFERENCIA', 'A_ESCLARECER']
    : ['DESPESA', 'TRANSFERENCIA', 'A_ESCLARECER'];
}

export function canMarkPfBusinessExpense(accountType, direction, classification) {
  return accountType === 'PF' && direction === 'SAIDA' && classification === 'DESPESA';
}

export function isValidPeriodMonth(month) {
  if (typeof month !== 'string') return false;
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) return false;
  const year = Number(match[1]);
  return year >= 1900 && year <= 9999;
}

export function shiftPeriodMonth(month, deltaMonths) {
  if (!isValidPeriodMonth(month)) return '2026-10';
  const [yStr, mStr] = month.split('-');
  let totalMonths = Number(yStr) * 12 + (Number(mStr) - 1) + Number(deltaMonths);
  const minMonths = 1900 * 12;
  const maxMonths = 9999 * 12 + 11;
  if (totalMonths < minMonths) totalMonths = minMonths;
  if (totalMonths > maxMonths) totalMonths = maxMonths;
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth = (totalMonths % 12) + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`;
}

export function defaultDateForMonth(month, currentDate) {
  if (typeof currentDate === 'string' && currentDate.startsWith(`${month}-`) && /^\d{4}-\d{2}-\d{2}$/.test(currentDate)) {
    return currentDate;
  }
  return `${month}-01`;
}

export function nextVersionRequiresReason(historyItems) {
  return Array.isArray(historyItems) && historyItems.length > 0;
}

export function nextMonthAction({ loaded, accounts, preview, deliveries }) {
  if (!loaded || !preview) return { kind: 'loading' };
  if (accounts.length === 0) return { kind: 'accounts' };
  if (preview.transactions.length === 0) return { kind: 'transactions' };
  const missingDocument = preview.pendingItems.find(
    (item) => item.status === 'PENDENTE' && item.pendingType === 'DOCUMENTO_AUSENTE'
  );
  if (missingDocument) return { kind: 'document', transactionId: missingDocument.transactionId };
  if (preview.pendingItems.some((item) => item.status === 'PENDENTE')) return { kind: 'review' };
  const latest = deliveries.reduce((current, item) => !current || item.versionNumber > current.versionNumber ? item : current, null);
  if (!latest) return { kind: 'capture' };
  if (latest.status === 'EM_FILA' || latest.status === 'EM_PROCESSAMENTO') return { kind: 'delivery' };
  if (latest.status === 'PRONTA' && latest.capturedRevision === preview.revision) return { kind: 'delivery' };
  return { kind: 'capture' };
}

export function generateIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `mimir-${globalThis.crypto.randomUUID()}`;
  }
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let token = 'mimir-';
  for (let i = 0; i < 24; i++) {
    token += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return token;
}

export function buildVerifierCommand(periodMonth, versionNumber) {
  const slug = `entrega-${periodMonth}-v${versionNumber}`;
  return `node packages/verifier/dist/index.js ./${slug} ./${slug}.manifesto.json`;
}

export function describeApiError(status, payload) {
  const code = payload && typeof payload === 'object' && typeof payload.code === 'string' ? payload.code : `HTTP_${status}`;
  const message =
    payload && typeof payload === 'object' && typeof payload.message === 'string'
      ? payload.message
      : 'Não foi possível concluir a operação.';
  const requestId =
    payload && typeof payload === 'object' && typeof payload.requestId === 'string' ? payload.requestId : null;
  return { code, message, requestId };
}
