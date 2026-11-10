import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inflateRawSync} from 'node:zlib';

const formatModule='../../apps/api/dist/packaging/format.js';
const htmlModule=new URL('../../apps/api/dist/packaging/html.js',import.meta.url);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=n=>`${String(n).padStart(8,'0')}-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pdf=label=>Buffer.from(`%PDF-1.7\nSynthetic I14 ${label}\n%%EOF\n`);

const pfDoc=pdf('origem'),pjDoc=pdf('transferencia');
const documents=[
  {documentId:id(301),originalName:'Nota <fiscal> & cia.pdf',mimeType:'application/pdf',sizeBytes:pfDoc.length,sha256:sha(pfDoc)},
  {documentId:id(302),originalName:'Transferência PJ.pdf',mimeType:'application/pdf',sizeBytes:pjDoc.length,sha256:sha(pjDoc)},
];
const base={sourceType:'MANUAL',sourceCode:'MANUAL',explanationOriginal:'',isPfBusinessExpense:false,documentIds:[],reimbursementStatus:'NAO_APLICAVEL'};
const expense={...base,transactionId:id(401),externalId:id(401),accountId:id(201),accountName:'Conta PF',accountType:'PF',occurredOn:'2026-10-03',direction:'SAIDA',
  amountCents:123456789,descriptionOriginal:'Hospedagem <b>anual</b>',categoryOriginal:'INFRAESTRUTURA',classification:'DESPESA',isPfBusinessExpense:true,
  documentIds:[id(301)],reimbursementStatus:'REEMBOLSADA_OUTRO_MES'};
const revenue={...base,transactionId:id(402),externalId:id(402),accountId:id(202),accountName:'Conta PJ',accountType:'PJ',occurredOn:'2026-10-12',direction:'ENTRADA',
  amountCents:1250,descriptionOriginal:'Serviço prestado',categoryOriginal:'SERVICOS',classification:'RECEITA'};
const outflow={...base,transactionId:id(404),externalId:id(404),accountId:id(202),accountName:'Conta PJ',accountType:'PJ',occurredOn:'2026-11-05',direction:'SAIDA',
  amountCents:123456789,descriptionOriginal:'Reembolso PF',categoryOriginal:'TRANSFERENCIAS',classification:'TRANSFERENCIA',documentIds:[id(302)],reimbursementStatus:'LIQUIDACAO_DE_REEMBOLSO'};
const links=[
  {reimbursementLinkId:id(501),pfExpenseTransactionId:id(401),pjReimbursementTransactionId:id(404),pfInflowTransactionId:null,amountCents:123456789,
    pfOriginDocumentIds:[id(301)],roleInPeriod:'DESPESA_ORIGEM_NO_PERIODO'},
  {reimbursementLinkId:id(502),pfExpenseTransactionId:id(409),pjReimbursementTransactionId:id(404),pfInflowTransactionId:id(410),amountCents:500,
    pfOriginDocumentIds:[],roleInPeriod:'CODIGO_FUTURO'},
];
function payload(overrides={}){
  return {schemaVersion:'mimir.snapshot.v1',workspace:{workspaceId:id(101),companyName:'Empresa <Sintética> Ltda',currency:'BRL'},
    delivery:{snapshotId:id(601),operationId:id(602),periodMonth:'2026-10',versionNumber:2,capturedRevision:9,rectificationReason:'Inclui <reembolso>',capturedAt:'2026-11-05T12:07:59.123Z'},
    summary:{cashFlowByAccount:[{accountId:id(201),accountName:'Conta PF',accountType:'PF',inflowCents:0,outflowCents:123456789,netCents:-123456789},
      {accountId:id(202),accountName:'Conta PJ',accountType:'PJ',inflowCents:1250,outflowCents:0,netCents:1250}],
      businessRevenueTotalCents:1250,businessExpenseTotalCents:123456789,reimbursementsSettledInPeriodCents:0,pendingCount:1,justifiedCount:1,
      categoryTotals:[{category:'INFRAESTRUTURA',inflowCents:0,outflowCents:123456789,netCents:-123456789},{category:'SERVICOS',inflowCents:1250,outflowCents:0,netCents:1250}]},
    transactions:[expense,revenue],contextTransactions:[outflow],reimbursementLinks:links,
    pendingItems:[
      {pendingId:id(701),transactionId:id(402),pendingType:'DOCUMENTO_AUSENTE',status:'JUSTIFICADA',description:'Movimentação sem comprovante.',justification:'Cliente <não> enviou'},
      {pendingId:id(702),transactionId:id(402),pendingType:'DUVIDA_CADASTRADA',status:'PENDENTE',description:'Conferir alíquota',justification:''},
      {pendingId:id(703),transactionId:id(401),pendingType:'REEMBOLSO_PF_PENDENTE',status:'RESOLVIDA',description:'Despesa PF sem reembolso.',justification:''},
    ],
    documents,period:{periodMonth:'2026-10',notes:''},...overrides};
}
const text=html=>html.replace(/<[^>]*>/g,' ');
async function render(p){const {renderSummaryHtml}=await import(htmlModule);return renderSummaryHtml(p).toString('utf8');}

test('I14 format: dinheiro, datas, competência, tamanhos, referências e rótulos contra oráculo escrito à mão',async()=>{
  const f=await import(formatModule).catch(()=>null);assert.ok(f,'I14 format.ts ausente');
  const money=[[0,'R$ 0,00'],[1,'R$ 0,01'],[99,'R$ 0,99'],[100,'R$ 1,00'],[1250,'R$ 12,50'],[-1250,'-R$ 12,50'],[-1,'-R$ 0,01'],
    [100000,'R$ 1.000,00'],[123456789,'R$ 1.234.567,89'],[-123456789,'-R$ 1.234.567,89'],[Number.MAX_SAFE_INTEGER,'R$ 90.071.992.547.409,91'],
    [-Number.MAX_SAFE_INTEGER,'-R$ 90.071.992.547.409,91']];
  for(const [cents,expected] of money)assert.equal(f.formatBrl(cents),expected,String(cents));
  for(const bad of [1.5,Number.NaN,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>f.formatBrl(bad),RangeError);
  assert.equal(f.formatCivilDate('2026-11-03'),'03/11/2026');assert.equal(f.formatCivilDate('2026-01-31'),'31/01/2026');assert.equal(f.formatCivilDate('03/11/2026'),'03/11/2026');
  const months=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  months.forEach((name,i)=>assert.equal(f.formatPeriodMonth(`2026-${String(i+1).padStart(2,'0')}`),`${name} de 2026`));
  assert.equal(f.formatPeriodMonth('2026-13'),'2026-13');
  assert.equal(f.formatCapturedAt('2026-11-05T12:07:59.123Z'),'05/11/2026 12:07 UTC');assert.equal(f.formatCapturedAt('2026-11-05T23:59:00+00:00'),'05/11/2026 23:59 UTC');
  assert.equal(f.formatCapturedAt('2026-11-05T12:07:59-03:00'),'2026-11-05T12:07:59-03:00');
  const sizes=[[0,'0 bytes'],[1,'1 byte'],[1023,'1.023 bytes'],[1024,'1,0 KB'],[1536,'1,5 KB'],[2048,'2,0 KB'],[1048524,'1.023,9 KB'],[1048575,'1,0 MB'],
    [1048576,'1,0 MB'],[5*1024*1024,'5,0 MB'],[1572864,'1,5 MB']];
  for(const [bytes,expected] of sizes)assert.equal(f.formatBytes(bytes),expected,String(bytes));
  for(const bad of [-1,1.5,Number.NaN])assert.throws(()=>f.formatBytes(bad),RangeError);
  assert.equal(f.shortRef('3f2a9c1d-0000-4000-8000-000000000001'),'#3f2a9c1d');
  const labels={ENTRADA:'Entrada',SAIDA:'Saída',RECEITA:'Receita',DESPESA:'Despesa',TRANSFERENCIA:'Transferência',A_ESCLARECER:'A esclarecer',
    PF:'Pessoa física',PJ:'Pessoa jurídica',NAO_APLICAVEL:'-',PENDENTE_REEMBOLSO:'Reembolso pendente',REEMBOLSADA_NO_MES:'Reembolsada no mês',
    REEMBOLSADA_OUTRO_MES:'Reembolsada em outro mês',LIQUIDACAO_DE_REEMBOLSO:'Liquidação de reembolso',DESPESA_ORIGEM_NO_PERIODO:'Despesa de origem no mês',
    REEMBOLSO_PJ_NO_PERIODO:'Reembolso PJ no mês',AMBOS_NO_PERIODO:'Despesa e reembolso no mês',ENTRADA_PF_NO_PERIODO:'Entrada PF no mês',
    DOCUMENTO_AUSENTE:'Documento ausente',CLASSIFICACAO_A_ESCLARECER:'Classificação a esclarecer',REEMBOLSO_PF_PENDENTE:'Reembolso PF pendente',
    DUVIDA_CADASTRADA:'Dúvida registrada',PENDENTE:'Aberta',JUSTIFICADA:'Justificada',RESOLVIDA:'Resolvida',VINCULO_DIRETO_PERIODO:'Movimentação do mês',
    CONTEXTO_REEMBOLSO:'Contexto de reembolso','application/pdf':'PDF','image/png':'PNG','image/jpeg':'JPEG'};
  for(const [code,expected] of Object.entries(labels))assert.equal(f.label(code),expected,code);
  assert.equal(f.label('CODIGO_FUTURO'),'CODIGO_FUTURO');assert.equal(f.label('constructor'),'constructor');
});

test('I14 resumo: valores, datas, competência, rótulos e acentos legíveis, sem códigos nem UUID como texto',async()=>{
  const html=await render(payload()),body=text(html);
  assert.match(html,/<title>Entrega de outubro de 2026 - versão 2<\/title>/);assert.match(html,/<h1>Entrega de outubro de 2026 - versão 2<\/h1>/);
  for(const expected of ['R$ 1.234.567,89','-R$ 1.234.567,89','R$ 12,50','03/10/2026','12/10/2026','05/11/2026','Saída · Despesa','Entrada · Receita',
    'Saída · Transferência','Reembolsada em outro mês','Liquidação de reembolso','Pessoa física','Pessoa jurídica','Conta PF (Pessoa física)','Conta PJ (Pessoa jurídica)'])
    assert.ok(body.includes(expected),expected);
  for(const heading of ['Visão geral','Fluxo por conta','Totais por categoria','Movimentações do mês','Contexto de outros meses','Vínculos de reembolso','Pendências','Documentos anexados'])
    assert.ok(html.includes(`<h2>${heading}</h2>`),heading);
  for(const code of ['SAIDA','ENTRADA','REEMBOLSADA_OUTRO_MES','LIQUIDACAO_DE_REEMBOLSO','DESPESA_ORIGEM_NO_PERIODO','DOCUMENTO_AUSENTE','DUVIDA_CADASTRADA',
    'JUSTIFICADA','RESOLVIDA','PENDENTE','NAO_APLICAVEL','VINCULO_DIRETO_PERIODO','Centavos','Pendencias','Movimentacoes','Vinculos','Descricao'])
    assert.ok(!body.includes(code),code);
  assert.doesNotMatch(body,/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.ok(body.includes('INFRAESTRUTURA'),'categoria é texto do usuário e aparece como digitada');
  for(const notice of ['não é escrituração, documento fiscal nem revisão profissional','Hashes não equivalem a assinatura digital',
    'cópia externa confiável do manifesto','não entram nos totais nem no CSV deste mês','não é somada como nova despesa'])
    assert.ok(body.includes(notice),notice);
});

test('I14 resumo: visão geral com versão, retificação, captura UTC, totais e situação das pendências',async()=>{
  const html=await render(payload());
  const row=(name,value)=>assert.ok(html.includes(`<tr><th>${name}</th><td>${value}</td></tr>`),`${name}: ${value}`);
  row('Empresa','Empresa &lt;Sintética&gt; Ltda');row('Competência','outubro de 2026');row('Versão','2 (retificação)');
  row('Motivo da retificação','Inclui &lt;reembolso&gt;');row('Capturada em','05/11/2026 12:07 UTC');row('Revisão capturada','9');
  row('Receita empresarial','R$ 12,50');row('Despesa empresarial','R$ 1.234.567,89');row('Reembolsos liquidados no mês','R$ 0,00');
  row('Pendências abertas','1');row('Pendências justificadas','1');row('Pendências resolvidas','1');
  assert.ok(text(html).includes('Justificativa é declaração do usuário; não resolve a pendência nem é validação fiscal.'));
  assert.ok(html.indexOf('<h2>Visão geral</h2>')<html.indexOf('<h2>Fluxo por conta</h2>'));
  const first=await render(payload({delivery:{...payload().delivery,versionNumber:1,rectificationReason:null}}));
  assert.ok(first.includes('<tr><th>Versão</th><td>1</td></tr>'));assert.ok(!/retifica/i.test(text(first)));
});

test('I14 resumo: vínculos e pendências descritos pela movimentação com referência curta',async()=>{
  const html=await render(payload());
  assert.ok(html.includes('<tr><td>03/10/2026 · Hospedagem &lt;b&gt;anual&lt;/b&gt; · R$ 1.234.567,89</td><td>05/11/2026 · Reembolso PF · R$ 1.234.567,89</td><td>Não registrada</td><td>R$ 1.234.567,89</td><td>Despesa de origem no mês</td><td>#00000501</td></tr>'));
  assert.ok(html.includes('<td>Movimentação fora do pacote #00000409</td>'));assert.ok(html.includes('<td>Movimentação fora do pacote #00000410</td>'));
  assert.ok(html.includes('<td>CODIGO_FUTURO</td>'),'papel desconhecido aparece literal');
  assert.ok(html.includes('<tr><td>12/10/2026 · Serviço prestado · R$ 12,50</td><td>Documento ausente</td><td>Justificada</td><td>Movimentação sem comprovante.</td><td>Cliente &lt;não&gt; enviou</td><td>#00000701</td></tr>'));
  assert.ok(html.includes('<td>Dúvida registrada</td><td>Aberta</td><td>Conferir alíquota</td><td>-</td><td>#00000702</td>'));
  assert.ok(html.includes('<td>#00000401</td></tr>'),'movimentação traz referência');
});

test('I14 resumo: documentos anexados com tipo, tamanho, motivo e link; seções vazias com frase de ausência',async()=>{
  const html=await render(payload());
  assert.ok(html.includes(`<tr><td><a href="anexos/${id(301)}.pdf">Nota &lt;fiscal&gt; &amp; cia.pdf</a></td><td>PDF</td><td>${pfDoc.length} bytes</td><td>Movimentação do mês</td></tr>`));
  assert.ok(html.includes(`<tr><td><a href="anexos/${id(302)}.pdf">Transferência PJ.pdf</a></td><td>PDF</td><td>${pjDoc.length} bytes</td><td>Contexto de reembolso</td></tr>`));
  assert.ok(html.includes('<td>Sem documento</td>'));
  const image={documentId:id(303),originalName:'recibo.png',mimeType:'image/png',sizeBytes:2048,sha256:'0'.repeat(64)};
  const withImage=await render(payload({documents:[...documents,image],transactions:[expense,{...revenue,documentIds:[id(303)]}]}));
  assert.ok(withImage.includes(`<tr><td><a href="anexos/${id(303)}.png">recibo.png</a></td><td>PNG</td><td>2,0 KB</td><td>Movimentação do mês</td></tr>`));
  const empty=await render(payload({contextTransactions:[],reimbursementLinks:[],pendingItems:[],documents:[],
    transactions:[{...revenue,documentIds:[]}]}));
  for(const phrase of ['Nenhum registro de outro mês.','Nenhum vínculo de reembolso.','Nenhuma pendência.','Nenhum documento anexado.'])
    assert.ok(empty.includes(`<p>${phrase}</p>`),phrase);
});

test('I14 resumo: bytes idênticos sob fusos e idiomas diferentes, escape preservado e pacote aceito pelo verificador',async()=>{
  const p=payload(),dir=await mkdtemp(join(tmpdir(),'mimir-i14-'));
  try{
    const input=join(dir,'payload.json');await writeFile(input,JSON.stringify(p));
    const script=`import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {renderSummaryHtml} from ${JSON.stringify(htmlModule.href)};
      process.stdout.write(createHash('sha256').update(renderSummaryHtml(JSON.parse(readFileSync(process.argv[1],'utf8')))).digest('hex'));`;
    const hashes=[['America/Sao_Paulo','pt_BR.UTF-8'],['Asia/Tokyo','ja_JP.UTF-8'],['Pacific/Kiritimati','de_DE.UTF-8']].map(([TZ,LANG])=>
      execFileSync(process.execPath,['--input-type=module','-e',script,input],{env:{...process.env,TZ,LANG,LC_ALL:LANG},encoding:'utf8'}));
    assert.equal(new Set(hashes).size,1);assert.equal(hashes[0],sha(Buffer.from(await render(p),'utf8')));
    const html=await render(p);
    for(const raw of ['<b>','<Sintética>','<reembolso>','<não>','<fiscal>'])assert.ok(!html.includes(raw),raw);
    assert.ok(!/<script|<form|<img|<link|https?:\/\/|\son[a-z]+=|style="/i.test(html));
    const {buildPackage}=await import('../../apps/api/dist/packaging/build.js');
    const {verifyDeliveryPackage}=await import('../../packages/verifier/dist/verifier.js');
    const bytesById=new Map([[id(301),pfDoc],[id(302),pjDoc]]);
    const verifiable={...p,reimbursementLinks:[links[0]]};
    const built=await buildPackage(verifiable,async documentId=>bytesById.get(documentId),join(dir,'work'),new AbortController().signal,new Date('2026-11-05T12:08:00Z'));
    const extracted=join(dir,'pkg'),zip=await readFile(built.zipPath);
    for(const [name,data] of readZip(zip)){await mkdir(join(extracted,name,'..'),{recursive:true});await writeFile(join(extracted,name),data);}
    assert.equal(await readFile(join(extracted,'resumo.html'),'utf8'),await render(verifiable));
    await writeFile(join(dir,'ref.manifesto.json'),built.manifest);
    const verified=await verifyDeliveryPackage(extracted,join(dir,'ref.manifesto.json'));
    assert.equal(verified.ok,true,verified.message);
  }finally{await rm(dir,{recursive:true,force:true});}
});

function readZip(bytes){
  const end=bytes.length-22,count=bytes.readUInt16LE(end+10),entries=new Map();let at=bytes.readUInt32LE(end+16);
  for(let i=0;i<count;i++){
    const method=bytes.readUInt16LE(at+10),csize=bytes.readUInt32LE(at+20),nameLength=bytes.readUInt16LE(at+28),offset=bytes.readUInt32LE(at+42);
    const name=bytes.subarray(at+46,at+46+nameLength).toString('utf8'),start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);
    const raw=bytes.subarray(start,start+csize);entries.set(name,method===8?inflateRawSync(raw):raw);at+=46+nameLength+bytes.readUInt16LE(at+30)+bytes.readUInt16LE(at+32);
  }
  return entries;
}
