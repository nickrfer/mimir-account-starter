import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [outDir, resultsDir, decision, firefoxVersion] = process.argv.slice(2);
if (!outDir || !resultsDir || !decision || !firefoxVersion) {
  console.error('uso: node c05-resultado.mjs <out do C05> <docs/avaliacao/resultados> <20/20|divergentes:n,n> <versao do Firefox>');
  process.exit(2);
}

const json = async path => JSON.parse(await readFile(join(outDir, path), 'utf8'));
const sha = async path => createHash('sha256').update(await readFile(join(outDir, path))).digest('hex');
const text = async path => (await readFile(join(outDir, path), 'utf8')).trim();

const run = await json('result.json');
const reference = await json('referencia-c05.json');
const comparison = await json('comparacao-c05.json');
const linuxVersions = (await text('linux/versoes.txt')).split(/\r?\n/).filter(Boolean);

const userAll = decision === '20/20';
const divergent = userAll ? [] : decision.replace(/^divergentes:/, '').split(',').map(Number);
const automaticDivergent = comparison.records.filter(r => !r.htmlOk || !r.loOk).map(r => r.n);
const records = comparison.records.map(r => ({
  n: r.n,
  ref: r.ref,
  description: r.description,
  chromium: r.htmlOk,
  libreoffice: r.loOk,
  user: !divergent.includes(r.n),
}));
const allEqual = records.every(r => r.chromium && r.libreoffice && r.user);
const verdict = allEqual ? 'ATENDE COM DESVIO DECLARADO' : 'NÃO ATENDE';

const result = {
  scenario: 'C05',
  project: run.project,
  commit: run.commit,
  tag: run.tag,
  productEqualToTag: run.productEqualToTag,
  docker: run.docker,
  node: run.node,
  postgres: run.postgres,
  container: run.container,
  startedAt: run.startedAt,
  criterion: 'Conferir 20 registros nas combinações Windows/Firefox/LibreOffice e Linux/Chromium/LibreOffice, preservando datas, acentos, valores e relações, offline e sem login (RNF-05).',
  package: { snapshotId: run.snapshotId, manifestSha256: run.manifestSha256, zipSha256: run.zipSha256, records: reference.records.length },
  combinations: [
    { id: 'linux-chromium-libreoffice', executed: true, os: (linuxVersions.find(l => l.startsWith('PRETTY_NAME=')) ?? '').replace(/^PRETTY_NAME="?|"$/g, '') || null, browser: linuxVersions.find(l => l.startsWith('Chromium')) ?? null, spreadsheet: linuxVersions.find(l => l.startsWith('LibreOffice')) ?? null, network: 'contêiner sem rede', htmlChecks: comparison.records.reduce((a, r) => a + r.htmlChecks.length, 0), csvChecks: comparison.records.reduce((a, r) => a + r.loChecks.length, 0), chromiumEqual: comparison.summary.chromiumOk, libreofficeEqual: comparison.summary.libreofficeOk },
    { id: 'windows-firefox', executed: true, browser: `Firefox ${firefoxVersion}`, network: 'perfil descartável com proxy em porta morta; resumo aberto por file://', evidence: 'windows/firefox-resumo.png' },
    { id: 'windows-libreoffice', executed: false, reason: 'Errata E3: instalação via winget cancelada por decisão do usuário; nenhuma biblioteca substitui o LibreOffice.' },
  ],
  evidence: {
    directory: outDir,
    files: Object.fromEntries(await Promise.all(['linux/chromium-resumo.png', 'linux/chromium-dom.html', 'linux/exportado/movimentacoes.csv', 'windows/firefox-resumo.png', 'comparacao-c05.json', 'referencia-c05.json', 'conferencia-c05.html'].map(async f => [f, await sha(f)]))),
  },
  userCheck: { decision, divergent, automaticDivergent },
  summary: { records: records.length, chromiumEqual: records.filter(r => r.chromium).length, libreofficeEqual: records.filter(r => r.libreoffice).length, userConfirmed: records.filter(r => r.user).length },
  deviations: ['Errata E3: combinação Windows/LibreOffice não executada; conferência da planilha só no LibreOffice do lado Linux.', 'Conferência final feita pelo próprio autor (protocolo §8).'],
  verdict,
  records,
};

const rows = records.map(r => `| ${r.n} | ${r.ref} | ${r.description} | ${r.chromium ? 'ok' : 'DIVERGE'} | ${r.libreoffice ? 'ok' : 'DIVERGE'} | ${r.user ? 'ok' : 'DIVERGE'} |`).join('\n');
const linux = result.combinations[0];
const md = `# Resultado C05 — Portabilidade offline (RNF-05)

Veredito: **${verdict.toLowerCase()}** ao critério: ${result.criterion}

- Commit \`${result.commit}\` (tag \`${result.tag}\`; produto igual à tag: ${result.productEqualToTag ? 'sim' : 'não'}); projeto \`${result.project}\`; Docker ${result.docker}; PostgreSQL ${result.postgres}; Node ${result.node}.
- Pacote: entrega com ${result.package.records} lançamentos de referência; manifesto \`${result.package.manifestSha256}\`; ZIP \`${result.package.zipSha256}\`. Oráculo: \`referencia-c05.json\`, gerado do manifesto do snapshot capturado.
- Linux: ${linux.os}, ${linux.browser} (headless) e ${linux.spreadsheet} (headless), contêiner sem rede. Chromium igual ao oráculo em ${linux.chromiumEqual}/20 registros (${linux.htmlChecks} campos); LibreOffice, em ${linux.libreofficeEqual}/20 (${linux.csvChecks} campos do CSV convertido).
- Windows: Firefox ${firefoxVersion}, perfil descartável com proxy em porta morta, \`resumo.html\` por \`file://\`; capturas conferidas pelo usuário.
- Conferência do usuário (${decision}): ${result.summary.userConfirmed}/20 registros conferidos. Divergências automáticas: ${automaticDivergent.length ? automaticDivergent.join(', ') : 'nenhuma'}.
- Desvios declarados: ${result.deviations.join(' ')}
- Evidências locais (não versionadas, hash SHA-256 no JSON): \`${outDir}\`.

| # | Ref | Descrição | Chromium | LibreOffice | Usuário |
| --- | --- | --- | --- | --- | --- |
${rows}
`;

await writeFile(join(resultsDir, 'C05.json'), JSON.stringify(result, null, 2) + '\n');
await writeFile(join(resultsDir, 'C05.md'), md);
console.log(verdict, JSON.stringify(result.summary));
