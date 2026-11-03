import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const HEADER='external_id,occurred_on,direction,amount_cents,description,category,classification,is_pf_business_expense,explanation';
const csv=(...lines)=>Buffer.from([HEADER,...lines].join('\r\n')+'\r\n','utf8');
const invalidCsv=line=>error=>error.status===422&&error.code==='INVALID_CSV'&&(line===undefined||error.message.includes(`Linha ${line}`));

test('I16 parser CSV estrito',async()=>{
  const mod=await import('../../apps/api/dist/imports/csv.js').catch(()=>null);assert.ok(mod,'I16 imports/csv.ts ausente');
  const {parseCsv}=mod;
  const basic=parseCsv(csv('A1,2026-10-08,SAIDA,2500,Despesa,SERVICOS,DESPESA,false,'));
  assert.deepEqual(basic,[{line:2,fields:['A1','2026-10-08','SAIDA','2500','Despesa','SERVICOS','DESPESA','false','']}]);
  const bom=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(HEADER+'\nA1,2026-10-08,SAIDA,1,d,c,DESPESA,false,x\nA2,2026-10-09,SAIDA,2,d,c,DESPESA,false,y')]);
  assert.deepEqual(parseCsv(bom).map(r=>[r.line,r.fields[0]]),[[2,'A1'],[3,'A2']],'BOM, LF e última linha sem quebra');
  const quoted=parseCsv(csv('"A,1",2026-10-08,SAIDA,1,"Diz ""oi""","linha1\r\nlinha2",DESPESA,false,""','B,2026-10-08,SAIDA,1,d,c,DESPESA,false,z'));
  assert.deepEqual(quoted[0].fields.slice(0,6),['A,1','2026-10-08','SAIDA','1','Diz "oi"','linha1\r\nlinha2']);
  assert.equal(quoted[1].line,4,'linha física considera quebra dentro de aspas');
  assert.throws(()=>parseCsv(Buffer.from([0x65,0xff,0x0a])),invalidCsv());
  assert.throws(()=>parseCsv(Buffer.from('')),invalidCsv());
  assert.throws(()=>parseCsv(Buffer.from(HEADER+'\r\n')),invalidCsv(),'sem linhas de dados');
  assert.throws(()=>parseCsv(Buffer.from(HEADER.replace('direction','direcao')+'\nA,2026-10-08,SAIDA,1,d,c,DESPESA,false,x')),invalidCsv(1));
  assert.throws(()=>parseCsv(Buffer.from(HEADER+',extra\nA,2026-10-08,SAIDA,1,d,c,DESPESA,false,x,y')),invalidCsv(1));
  assert.throws(()=>parseCsv(csv('A1,2026-10-08,SAIDA,1,d,c,DESPESA,false')),invalidCsv(2),'coluna a menos');
  assert.throws(()=>parseCsv(csv('A1,2026-10-08,SAIDA,1,d,c,DESPESA,false,x','','A2,2026-10-08,SAIDA,1,d,c,DESPESA,false,x')),e=>invalidCsv(3)(e)&&e.message.includes('linha vazia'));
  assert.throws(()=>parseCsv(csv('A1,2026-10-08,SAIDA,1,d,c,DESPESA,false,x','A2,2026-10-08,SAIDA,1,d,c,DESPESA,false,x,y')),invalidCsv(3),'coluna a mais');
  assert.throws(()=>parseCsv(csv('A1,2026-10-08,SAIDA,1,d"x,c,DESPESA,false,x')),invalidCsv(2),'aspas no meio do campo');
  assert.throws(()=>parseCsv(csv('"A1,2026-10-08,SAIDA,1,d,c,DESPESA,false,x')),invalidCsv(2),'aspas não fechadas');
  assert.throws(()=>parseCsv(csv('"A1"x,2026-10-08,SAIDA,1,d,c,DESPESA,false,x')),invalidCsv(2),'texto após aspas');
  assert.throws(()=>parseCsv(Buffer.from(HEADER.replace('occurred_on','external_id')+'\nA,2026-10-08,SAIDA,1,d,c,DESPESA,false,x')),invalidCsv(1),'coluna repetida no cabeçalho');
  const many=csv(...Array.from({length:1001},(_,i)=>`A${i},2026-10-08,SAIDA,1,d,c,DESPESA,false,`));
  assert.throws(()=>parseCsv(many),invalidCsv(),'mais de 1.000 linhas');
  assert.equal(parseCsv(csv(...Array.from({length:1000},(_,i)=>`A${i},2026-10-08,SAIDA,1,d,c,DESPESA,false,`))).length,1000);
});

test('I16 normalização, validação por linha e fingerprint contra vetores versionados',async()=>{
  const mod=await import('../../apps/api/dist/imports/rows.js').catch(()=>null);assert.ok(mod,'I16 imports/rows.ts ausente');
  const {normalizeRow,importFingerprint}=mod;
  const vectors=JSON.parse(await readFile(new URL('../../packages/contracts/vetores-fingerprint.json',import.meta.url),'utf8'));
  const cases=(vectors.vectors??vectors.cases??vectors).filter(v=>v.case?.startsWith('csv_'));
  assert.equal(cases.length,2);
  for(const v of cases){
    const [,occurredOn,direction,amountCents,description,category,classification,isPfBusinessExpense,explanation]=v.normalizedArray;
    assert.equal(importFingerprint({occurredOn,direction,amountCents,description,category,classification,isPfBusinessExpense,explanation}),v.sha256,v.case);
  }
  const fields=(over={})=>{const base={external_id:' A-1 ',occurred_on:'2026-10-08',direction:'SAIDA',amount_cents:'2500',description:' Café \r\nlinha ',category:'SERVICOS',
    classification:'DESPESA',is_pf_business_expense:'false',explanation:'x\r\ny'};return Object.values({...base,...over});};
  const ok=normalizeRow({line:2,fields:fields()},'2026-10','PJ');
  assert.equal(ok.ok,true);
  assert.deepEqual(ok.row,{externalId:'A-1',occurredOn:'2026-10-08',direction:'SAIDA',amountCents:2500,description:'Café \nlinha',category:'SERVICOS',
    classification:'DESPESA',isPfBusinessExpense:false,explanation:'x\ny'});
  assert.equal(ok.fingerprint,importFingerprint(ok.row));
  assert.equal(normalizeRow({line:2,fields:fields({external_id:'a-1'})},'2026-10','PJ').row.externalId,'a-1','sensível a maiúsculas');
  assert.equal(normalizeRow({line:2,fields:fields({external_id:' A\r\nB́ '})},'2026-10','PJ').row.externalId,'A\r\nB́'.normalize('NFC'),'external_id: só NFC e trim');
  const bad=(over,code,accountType='PJ')=>{const r=normalizeRow({line:7,fields:fields(over)},'2026-10',accountType);
    assert.equal(r.ok,false,JSON.stringify(over));assert.equal(r.line,7);assert.equal(r.code,code,JSON.stringify(over));assert.ok(r.message.length>0);return r;};
  for(const amount of ['12,50','12.50','-1','0','1e3','+5','099','100000000000',' 5','',' '])bad({amount_cents:amount},'INVALID_FIELD');
  for(const date of ['2026-02-30','2026-10-8','08/10/2026',''])bad({occurred_on:date},'INVALID_FIELD');
  bad({occurred_on:'2026-11-01'},'OUT_OF_PERIOD');
  for(const value of ['sim','TRUE','1',''])bad({is_pf_business_expense:value},'INVALID_FIELD');
  bad({direction:'saida'},'INVALID_FIELD');bad({classification:'OUTRA'},'INVALID_FIELD');
  bad({description:'   '},'INVALID_FIELD');bad({description:'x'.repeat(501)},'INVALID_FIELD');bad({category:''},'INVALID_FIELD');
  bad({explanation:'x'.repeat(2001)},'INVALID_FIELD');bad({external_id:'  '},'INVALID_FIELD');bad({external_id:'x'.repeat(201)},'INVALID_FIELD');
  assert.equal(bad({external_id:'  '},'INVALID_FIELD').externalId,null);
  assert.equal(bad({amount_cents:'x'},'INVALID_FIELD').externalId,'A-1');
  bad({classification:'RECEITA'},'INVALID_RULE');bad({direction:'ENTRADA'},'INVALID_RULE');
  bad({is_pf_business_expense:'true'},'INVALID_RULE','PJ');
  assert.equal(normalizeRow({line:2,fields:fields({is_pf_business_expense:'true'})},'2026-10','PF').ok,true);
  bad({is_pf_business_expense:'true',classification:'TRANSFERENCIA'},'INVALID_RULE','PF');
  const fixture=await readFile(new URL('../../fixtures/importacao_exemplo.csv',import.meta.url));
  const {parseCsv}=await import('../../apps/api/dist/imports/csv.js');
  const rows=parseCsv(fixture).map(r=>normalizeRow(r,'2026-10','PJ'));
  assert.deepEqual(rows.map(r=>[r.ok,r.row.externalId]),[[true,'CSV-001'],[true,'CSV-002']]);
  assert.equal(rows[0].fingerprint,rows[1].fingerprint,'fixture: mesmo conteúdo, IDs distintos');
});

test('I16 classificação contra oráculo escrito à mão',async()=>{
  const mod=await import('../../apps/api/dist/imports/classify.js').catch(()=>null);assert.ok(mod,'I16 imports/classify.ts ausente');
  const {classifyImport}=mod;
  const valid=(line,externalId,fingerprint)=>({ok:true,line,row:{externalId},fingerprint});
  const invalid=(line,externalId)=>({ok:false,line,externalId,code:'INVALID_FIELD',message:'Campo inválido'});
  const fp=c=>c.repeat(64);
  const origins=new Map([['OLD',{fingerprint:fp('a'),transactionStatus:'ATIVA'}],['EDIT',{fingerprint:fp('b'),transactionStatus:'ATIVA'}],
    ['GONE',{fingerprint:fp('c'),transactionStatus:'EXCLUIDA'}],['GONE2',{fingerprint:fp('d'),transactionStatus:'EXCLUIDA'}]]);
  const result=classifyImport([valid(2,'N1',fp('1')),valid(3,'OLD',fp('a')),valid(4,'EDIT',fp('9')),valid(5,'GONE',fp('c')),valid(6,'N1',fp('1')),
    valid(7,'D',fp('2')),valid(8,'D',fp('3')),invalid(9,'N2'),invalid(10,null),valid(11,'N3',fp('4')),valid(12,'OLD',fp('a'))],origins);
  const view=result.rows.map(r=>[r.line,r.externalId,r.status,r.code]);
  assert.deepEqual(view,[
    [2,'N1','NOVA',null],[3,'OLD','IGNORADA',null],[4,'EDIT','CONFLITO','ORIGIN_CHANGED'],[5,'GONE','CONFLITO','ORIGIN_DELETED'],[6,'N1','REPETIDA',null],
    [7,'D','CONFLITO','DUPLICATE_KEY_DIFFERENT_CONTENT'],[8,'D','CONFLITO','DUPLICATE_KEY_DIFFERENT_CONTENT'],[9,'N2','INVALIDA','INVALID_FIELD'],
    [10,null,'INVALIDA','INVALID_FIELD'],[11,'N3','NOVA',null],[12,'OLD','IGNORADA',null]]);
  assert.deepEqual(result.totals,{rows:11,new:2,ignored:2,repeated:1,conflicting:4,invalid:2});
  assert.equal(classifyImport([valid(2,'GONE2',fp('e'))],origins).rows[0].code,'ORIGIN_DELETED','exclusão prevalece sobre conteúdo alterado');
  assert.deepEqual(result.newRows.map(r=>r.line),[2,11]);
  assert.ok(result.rows.every(r=>'message' in r&&'fingerprint' in r));
  assert.equal(result.rows.find(r=>r.line===9).fingerprint,null);
  const fresh=classifyImport([valid(2,'X',fp('5')),valid(3,'x',fp('5'))],new Map());
  assert.deepEqual(fresh.rows.map(r=>r.status),['NOVA','NOVA'],'chave sensível a maiúsculas');
  assert.deepEqual(classifyImport([valid(2,'Z',fp('6')),valid(3,'Z',fp('6')),valid(4,'Z',fp('7'))],new Map()).rows.map(r=>r.status),['CONFLITO','CONFLITO','CONFLITO'],
    'qualquer divergência coloca todas as ocorrências da chave em conflito');
});
