# Formato da entrega e verificação

A forma vigente do manifesto é v2. Leia também category-totals.md; os totais por categoria são obrigatórios. Regras referenciadas por números de seção abaixo vêm da especificação de domínio, não de arquivos institucionais.


### 7.1 Estrutura e limites

Cada entrega contém resumo.html, movimentacoes.csv, manifesto.json e anexos/{documentId}.{ext}. Somente arquivos descritos no manifesto, mais o próprio manifesto, são permitidos. O manifesto não lista o próprio hash. A cópia externa fica fora do diretório extraído e fora do ZIP; o endpoint de manifesto retorna os mesmos bytes do arquivo publicado, sem serializar JSONB novamente.

HTML estático, UTF-8, com textos escapados, sem JavaScript, recursos remotos, formulários ou conteúdo ativo. Exibe empresa sintética, mês, versão, revisão, totais, pendências e vínculos com documentos relativos. Não afirma revisão contábil. CSV contém só movimentações do mês, com centavos inteiros e data ISO; inclui identificadores e IDs documentais. Campos textuais cujo primeiro caractere significativo possa iniciar fórmula (=, +, -, @, tabulação ou quebra de linha inicial) recebem apóstrofo de proteção. O manifesto mantém os textos originais normalizados. Hashes são calculados após escape, neutralização e codificação final.

Empacotamento lê metadados e um documento de até 5 MiB por vez com contrapressão. Temporário ZIP é limitado a 110 MiB durante a escrita; atingir o limite aborta a tentativa e remove temporário. Há limite de 100 MiB de anexos únicos e 1.000 registros selecionados. A materialização do ZIP na gravação e download pode elevar memória; é risco a medir, não eliminado por usar streams na compactação. Arquivos temporários pertencem a operationId/token, sem nomes fornecidos pelo usuário; limpar órfãos na inicialização somente dentro do diretório controlado da aplicação.

### 7.2 Esquema do manifesto

schemaVersion = mimir.manifest.v2. O manifesto contém workspace, delivery, summary (incluindo categoryTotals), files, transactions, contextTransactions, reimbursementLinks e pendingItems. Cada transação inclui accountId/nome/tipo, valor, data, classificação, textos originais e documentIds. O arquivo JSON Schema valida forma, tipos e limites locais; regras relacionais e somas exigem validação adicional.

O verificador deve exigir unicidade de transactionId entre registros principais e de contexto, unicidade de file.path e documentId de anexos e resolução de todas as referências. Principal deve pertencer ao mês; contexto deve pertencer a outro mês e ser necessário a vínculo incluído. Cada vínculo resolve PF/PJ e entrada opcional, valida tipos, valor, direção, datas e papel no período; documento de origem deve existir no conjunto. O papel do vínculo no período é DESPESA_ORIGEM_NO_PERIODO, REEMBOLSO_PJ_NO_PERIODO ou AMBOS_NO_PERIODO conforme as datas da saída PF e da saída PJ. Quando somente a entrada PF opcional ocorre no mês capturado, usar ENTRADA_PF_NO_PERIODO; ela afeta o fluxo da conta PF, sem nova despesa ou nova liquidação PJ. Pendências referem-se apenas a transações principais. Recalcular totais e contagens; não confiar somente no summary declarado.

Tamanho de arquivo é o número de bytes final. SHA-256 é hexadecimal minúsculo de 64 caracteres. Caminhos são relativos, sem caminho absoluto, .., barra invertida, NUL ou links simbólicos. Não seguir symlinks para fora do diretório. Rejeitar entradas duplicadas, arquivos extras, ausentes e estrutura inválida. Diretórios vazios podem existir, mas não são arquivos extras. Para limitar também metadados, esta especificação acrescenta até 1.000 documentos únicos e 10.000 associações entre registros e documentos por captura; o manifesto é limitado a 8 MiB. Esses tetos complementam os limites de bytes da v0.3, não representam capacidade medida. Validar contagens e tamanho do payload antes do commit da captura; o empacotador também verifica o limite do manifesto final e registra falha explícita se excedido. Exercitar essas fronteiras com textos e associações no limite.

### 7.3 Referência confiável e resultado do CLI

Contrato de uso: informar um diretório extraído e um caminho externo de manifesto de referência. O verificador lê a referência por canal cuja confiança o usuário estabeleceu, compara seus bytes com manifesto.json do pacote, valida esquema e relações, depois verifica arquivos e hashes. Baixar manifesto e pacote do mesmo servidor ajuda a separar cópias, mas não comprova autenticidade contra comprometimento desse servidor. Não há assinatura digital nem garantia contra administrador privilegiado.

Resultado pretendido do CLI: exit code 0 para pacote íntegro perante a referência; 1 para divergência estrutural, relacional ou de integridade; 2 para uso incorreto/erro operacional. Saída identifica o arquivo/ID problemático sem expor conteúdo sensível. Sem referência externa, não declarar integridade autenticada: eventual conferência interna é limitada e não satisfaz RF-14 nesta especificação.

### 7.4 Exemplos sintéticos incluídos

Há três entregas ilustrativas: outubro v1 antes do reembolso; novembro v1 após o reembolso; outubro v2 capturado após a mudança. Outubro v1 permanece sem reembolso, outubro v2 explica o vínculo e novembro mostra a liquidação sem duplicar despesa. As datas de novembro são fictícias, não eventos ocorridos ou resultados futuros previstos.

Os exemplos foram montados como documentos e dados de teste, fora da aplicação, que ainda não foi construída. Os PNGs dizem explicitamente que são comprovantes sintéticos sem validade. Cada diretório tem uma cópia externa do manifesto em referencias_confiaveis. A verificação local feita neste pacote avalia os exemplos documentais; não conta como execução do futuro CLI, de C04 ou dos demais experimentos do TCC.

