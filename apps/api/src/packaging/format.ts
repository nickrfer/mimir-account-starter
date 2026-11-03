const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const LABELS: ReadonlyMap<string, string> = new Map([
  ['ENTRADA', 'Entrada'], ['SAIDA', 'Saída'],
  ['RECEITA', 'Receita'], ['DESPESA', 'Despesa'], ['TRANSFERENCIA', 'Transferência'], ['A_ESCLARECER', 'A esclarecer'],
  ['PF', 'Pessoa física'], ['PJ', 'Pessoa jurídica'],
  ['NAO_APLICAVEL', '—'], ['PENDENTE_REEMBOLSO', 'Reembolso pendente'], ['REEMBOLSADA_NO_MES', 'Reembolsada no mês'],
  ['REEMBOLSADA_OUTRO_MES', 'Reembolsada em outro mês'], ['LIQUIDACAO_DE_REEMBOLSO', 'Liquidação de reembolso'],
  ['DESPESA_ORIGEM_NO_PERIODO', 'Despesa de origem no mês'], ['REEMBOLSO_PJ_NO_PERIODO', 'Reembolso PJ no mês'],
  ['AMBOS_NO_PERIODO', 'Despesa e reembolso no mês'], ['ENTRADA_PF_NO_PERIODO', 'Entrada PF no mês'],
  ['DOCUMENTO_AUSENTE', 'Documento ausente'], ['CLASSIFICACAO_A_ESCLARECER', 'Classificação a esclarecer'],
  ['REEMBOLSO_PF_PENDENTE', 'Reembolso PF pendente'], ['DUVIDA_CADASTRADA', 'Dúvida registrada'],
  ['PENDENTE', 'Aberta'], ['JUSTIFICADA', 'Justificada'], ['RESOLVIDA', 'Resolvida'],
  ['VINCULO_DIRETO_PERIODO', 'Movimentação do mês'], ['CONTEXTO_REEMBOLSO', 'Contexto de reembolso'],
  ['application/pdf', 'PDF'], ['image/png', 'PNG'], ['image/jpeg', 'JPEG'],
]);

const groupThousands = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export function formatBrl(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError('Valor monetário deve ser inteiro seguro em centavos.');
  const absolute = Math.abs(cents), fraction = absolute % 100;
  const reais = (absolute - fraction) / 100;
  return `${cents < 0 ? '-' : ''}R$ ${groupThousands(String(reais))},${String(fraction).padStart(2, '0')}`;
}

export function formatCivilDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

export function formatPeriodMonth(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} de ${match[1]}` : value;
}

export function formatCapturedAt(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|\+00:?00)$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]} ${match[4]}:${match[5]} UTC` : value;
}

function tenths(bytes: number, unit: number): string {
  const rounded = Math.round((bytes * 10) / unit);
  return `${groupThousands(String(Math.floor(rounded / 10)))},${rounded % 10}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Tamanho deve ser inteiro não negativo.');
  if (bytes < 1024) return `${groupThousands(String(bytes))} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (Math.round((bytes * 10) / 1024) < 10240) return `${tenths(bytes, 1024)} KB`;
  return `${tenths(bytes, 1024 * 1024)} MB`;
}

export const shortRef = (id: string) => `#${id.slice(0, 8)}`;

export const label = (code: string) => LABELS.get(code) ?? code;
