# Domínio e regras financeiras

A forma vigente do manifesto é v2. Leia também category-totals.md; os totais por categoria são obrigatórios. Regras referenciadas por números de seção abaixo vêm da especificação de domínio, não de arquivos institucionais.


### 3.1 Valores e períodos

Valores de movimentações são inteiros positivos em centavos, até 99.999.999.999 por registro. O sinal decorre de direction: ENTRADA ou SAIDA. Totais são inteiros, podendo ser negativos para saldo líquido. Não se utiliza ponto flutuante decimal para moeda. Com 1.000 registros, os totais permanecem dentro da faixa segura de inteiros do JavaScript; a conversão do BIGINT do driver exige validação explícita. Revisão e token devem igualmente rejeitar conversão fora da faixa segura, sem arredondamento.

occurredOn é data civil válida em YYYY-MM-DD, sem conversão de fuso; periodMonth deriva dessa data. Instantes operacionais usam UTC e formato RFC 3339. Mês é unidade de organização financeira, não competência contábil. Limitar os anos aceitos a 1900–9999 é uma decisão de contrato para impedir datas inválidas ou dependentes de interpretação do ambiente.

RECEITA exige ENTRADA; DESPESA exige SAIDA. TRANSFERENCIA e A_ESCLARECER admitem ambas as direções. A marca isPfBusinessExpense exige conta PF, saída e classificação DESPESA. Receitas PF não integram automaticamente o resumo empresarial. Despesas PJ classificadas como DESPESA entram no resumo, mas isso não certifica sua natureza ou dedutibilidade.

### 3.2 Totais sem duplicação

| Indicador | Regra |
| --- | --- |
| Fluxo por conta | Todas as entradas e saídas ativas ocorridas no mês, inclusive transferências; saldo líquido = entradas − saídas. |
| Receitas empresariais | Entradas RECEITA em contas PJ no mês. |
| Despesas empresariais | Saídas DESPESA em contas PJ, mais saídas DESPESA PF com marca empresarial, no mês do pagamento. |
| Reembolsos liquidados | Soma dos vínculos ativos cuja saída PJ ocorreu no mês. Não somar novamente como despesa. |
| Pendências | Contar separadamente PENDENTE e JUSTIFICADA; RESOLVIDA não entra nessas contagens. |

Contas incluídas apenas como contexto de vínculo entre meses não adicionam movimentações aos totais do mês. O pacote distingue transactions, do período, de contextTransactions, de outros meses. Uma movimentação de contexto não aparece no CSV mensal nem é contada no resumo.

### 3.3 Reembolso integral e edição posterior

Um vínculo ativo relaciona uma saída PF empresarial a uma saída PJ TRANSFERENCIA de igual valor. A data PJ deve ser igual ou posterior à data PF; antecipações não são reembolsos deste escopo. Cada saída PF e cada saída PJ participa de no máximo um vínculo ativo. A entrada PF é opcional; quando informada, pertence à mesma conta PF da despesa, tem igual valor, classificação TRANSFERENCIA e data não anterior à saída PJ. Ela também participa de no máximo um vínculo ativo. Todas as entidades pertencem ao mesmo espaço.

Alterar conta, data, valor, direção, classificação ou marca empresarial de uma movimentação vinculada é rejeitado com 409 LINKED_TRANSACTION_CONFLICT enquanto o vínculo estiver ativo. O usuário desfaz o vínculo, corrige e refaz quando necessário; cada comando é transacional e incrementa revision. Descrição, categoria e explicação podem ser editadas, preservando snapshots anteriores. Excluir logicamente uma movimentação vinculada exige desfazer o vínculo antes.

Capturar um mês inclui os vínculos que tocam pelo menos uma de suas movimentações e os registros externos diretamente necessários para explicar esses vínculos, inclusive a entrada PF opcional. A inclusão é de um salto: não segue indefinidamente outros relacionamentos. Incluem-se todos os documentos desses registros, deduplicados por documentId. O limite de 1.000 movimentações abrange transactions mais contextTransactions; essa precisão evita que o contexto burle o limite da v0.3. O limite de 100 MiB soma documentos únicos da seleção.

Para registros manuais, o servidor preencherá sourceType e sourceCode como MANUAL e externalId com o próprio UUID da movimentação, sem criar import_origins artificial. Para CSV, sourceCode, externalId e fingerprint vêm da procedência imutável. O cliente não precisa inventar identidade externa para um lançamento manual.

### 3.4 CSV e procedência de importação

O formato v1 é CSV UTF-8, separador vírgula, cabeçalho fixo, aspas duplas com duplicação para escape. Aceitar LF ou CRLF e BOM UTF-8 de entrada; saída sem BOM e com CRLF. Não aceitar codificação inválida, cabeçalhos repetidos, colunas extras ou datas impossíveis. Arquivo de entrada limitado a 1 MiB e 1.000 linhas de dados nesta PoC; esses limites de transporte são decisões novas do documento técnico, não metas de desempenho adicionais.

Campos, nesta ordem: external_id, occurred_on, direction, amount_cents, description, category, classification, is_pf_business_expense, explanation. sourceCode, accountId e periodMonth são informados no comando do lote. A conta pertence ao proprietário e todas as linhas devem pertencer ao período informado. Valores são dígitos de centavos; booleanos somente true/false; não interpretar notação científica ou valores com separador decimal.

A identidade é (workspaceId, accountId de origem, sourceCode, externalId). sourceCode é um identificador estável escolhido pelo usuário para a fonte; trocar esse identificador permite novas identidades e deve gerar aviso na interface. externalId é obrigatório, sensível a maiúsculas e preservado após normalização Unicode NFC e remoção de espaços periféricos. Sem identificador estável, o usuário deve preparar o CSV antes; não deduplicar somente por valor e data.

O fingerprint da linha usa SHA-256 sobre os bytes UTF-8 de um array JSON compacto com ordem fixa: [versão 1, occurredOn, direction, amountCents inteiro, description, category, classification, isPfBusinessExpense booleano, explanation]. Strings são NFC, quebras CRLF/CR viram LF e espaços periféricos são removidos; description não pode ficar vazia. Não se usa concatenação ambígua com separador. A mesma normalização deve alimentar a persistência e o fingerprint.

A procedência original fica em import_origins, imutável, separada do registro financeiro editável. Editar classificação ou descrição não recalcula o fingerprint original. Reimportar a mesma origem e o mesmo conteúdo ignora a linha, preservando a edição local; conteúdo de origem diferente gera conflito. Origem associada a registro excluído gera conflito explícito, sem restaurar silenciosamente. A conta de uma transação importada não pode ser trocada; uma correção exige exclusão lógica e novo registro explicitamente criado.

Duplicatas idênticas dentro do próprio arquivo são agrupadas em uma inserção e informadas como repetidas. Mesma chave com conteúdos distintos no arquivo gera conflito. Prévia é leitura consistente sem incremento de revision. Confirmação recebe novamente o arquivo, seu hash bruto e expectedRevision; verifica hash e revalida integralmente dentro do protocolo de mutação. Qualquer erro ou conflito rejeita o lote inteiro. Repetição composta apenas de origens já importadas não muda revision; um lote com novos registros incrementa uma vez. Arquivo inválido retorna prévia com erros por linha; o comando de confirmação inválido retorna 422, e conflito de origem/revisão retorna 409.

### 3.5 Documentos e pendências

Documentos aceitos: PDF, PNG e JPEG, não vazios e até 5 MiB. Verificar extensão permitida, MIME declarado, assinatura e tamanho; divergência retorna 415 ou 422 conforme a causa. Essa validação não comprova ausência de malware. Não renderizar documentos ativos dentro da aplicação; download usa Content-Disposition attachment e nosniff. Nome original é metadado; o caminho de arquivo é gerado com UUID e extensão validada, sem usar o nome recebido como caminho.

Upload da jornada inicial cria documento e vínculo com a movimentação na mesma transação. Substituição cria novo documentId e troca o vínculo atual atomicamente, preservando o anterior. Desvincular não exclui os bytes. O mesmo documento pode comprovar mais de uma movimentação do espaço; há apenas um arquivo no pacote e múltiplas referências.

Pendências automáticas: documento ausente em RECEITA/DESPESA, classificação A_ESCLARECER e despesa PF empresarial sem reembolso. Transferência de reembolso sem anexo próprio pode apoiar-se nos documentos de origem; a falta de documento na despesa de origem continua visível. O usuário pode registrar uma dúvida manual por movimentação e editar seu texto. Estados: PENDENTE, JUSTIFICADA e RESOLVIDA. Justificativa exige texto de 3–2.000 caracteres e não equivale a resolução ou validação fiscal.

Condição automática eliminada resolve a pendência. Se ela reaparecer após estar resolvida, reabrir PENDENTE e limpar justificativa antiga. Se a condição persistir, manter JUSTIFICADA, salvo alteração material no registro relacionado; nesse caso reabrir para nova avaliação. São materiais valor, conta, data, classificação, marca empresarial e vínculos documentais/de reembolso. Mudança de explicação isolada não invalida justificativa. Dúvida manual é resolvida ou reaberta explicitamente. A reconciliação das pendências ocorre na mesma transação da mutação, nunca como escrita escondida em uma leitura.

