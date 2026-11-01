# Requisitos da PoC

Especificados, não executados. IDs mantidos para rastreabilidade de engenharia. Critérios C01-C06 são avaliações futuras, não resultados deste scaffold.

## 2.2 Requisitos Funcionais

A lista reúne 14 requisitos macro. B = baixa, M = média, A = alta. A prioridade indica dependência do fluxo e da avaliação: idempotência, versões e verificador integram o núcleo; a importação CSV tem prioridade média, pois registros manuais permitem iniciar a validação. Todos os RF permanecem no escopo. A opcionalidade do CLI para o contador não reduz sua importância experimental.

| ID | Descrição resumida | Dif. | Prior. |
| --- | --- | --- | --- |
| RF-01 | Autenticar usuários provisionados na instalação, iniciar e encerrar sessão e restringir cada usuário ao próprio espaço de trabalho. | M | A |
| RF-02 | Criar e consultar períodos mensais e cadastrar contas identificadas como PF ou PJ, vinculadas ao espaço de trabalho. | B | A |
| RF-03 | Importar CSV no esquema documentado, apresentar prévia e erros e confirmar somente um lote válido. Repetir o mesmo lote não duplicará registros. | M | M |
| RF-04 | Criar, corrigir e excluir logicamente movimentações do acervo de trabalho, preservando versões de entrega já capturadas. | M | A |
| RF-05 | Classificar movimentações como receita, despesa, transferência ou item a esclarecer e registrar explicações, sem atribuir validade contábil ou fiscal. | B | A |
| RF-06 | Anexar PDF/PNG/JPEG e associar documentos a movimentações. Substituir documento criará novo identificador e conteúdo imutável. | M | A |
| RF-07 | Relacionar despesa empresarial paga pela PF e reembolso integral pela PJ, inclusive entre meses diferentes, sem duplicar a despesa no resumo. | M | A |

Requisitos Funcionais - continuação

| ID | Descrição resumida | Dif. | Prior. |
| --- | --- | --- | --- |
| RF-08 | Listar pendências por ausência de documento ou dúvida cadastrada e registrar justificativa, mantendo distinguíveis os estados pendente e justificado. | B | A |
| RF-09 | Apresentar revisão do período com totais por categoria e conta, vínculos PF/PJ e pendências. A ausência de pendências não certificará regularidade fiscal. | M | A |
| RF-10 | Solicitar a captura de uma entrega identificada por proprietário, período e versão, a partir da revisão exibida; detectar revisão desatualizada. | A | A |
| RF-11 | Consultar a operação de geração e repetir o mesmo comando sem criar outra entrega; informar estados em fila, em processamento, pronta ou falha. | A | A |
| RF-12 | Baixar ZIP da entrega pronta contendo resumo HTML, CSV, todos os documentos referenciados no snapshot e manifesto com identificadores, relações e hashes. | A | A |
| RF-13 | Gerar nova versão após correções, registrar a explicação da retificação e consultar/baixar versões anteriores. Não haverá diff automático nesta PoC. | M | A |
| RF-14 | Verificar localmente os arquivos de um pacote extraído em relação ao manifesto fornecido, indicando ausências, itens extras, divergências de hash e referências inválidas. | M | A |

O CSV identificará registros por proprietário, conta, fonte e ID externo. A procedência e o fingerprint original serão imutáveis: reimportação idêntica preservará edições locais; origem alterada ou registro excluído gerará conflito. O fingerprint usará array JSON determinístico. Data e valor iguais não bastarão para deduplicar.

A justificativa de uma pendência será uma declaração do usuário. O vínculo de documento poderá apoiar vários registros sem dividir valores automaticamente. Pagamentos parciais, rateios complexos, portal do contador, OFX, OCR, Android e integração bancária permanecerão fora da primeira PoC.

## 2.3 Requisitos Não-funcionais

Os critérios a seguir são metas propostas. Nenhum está declarado atendido antes da execução dos cenários. Percentuais de sucesso referem-se ao conjunto de testes explicitamente definido, não a garantia universal de ausência de falhas.

| ID | Descrição | Prior. |
| --- | --- | --- |
| RNF-01 Consistência | O sistema deverá capturar uma revisão consistente de dados e referências documentais ou rejeitar revisão obsoleta com HTTP 409. O conteúdo não poderá misturar revisões. Critério: nenhuma mistura nas 100 intercalações controladas do C01. | A |
| RNF-02 Recuperação | O sistema deverá recuperar operações sem duplicar versões nem publicar pacotes parciais. Nas 30 execuções com uma falha transitória do C02, deverá concluir em até 120 s após restabelecer API e banco. Falhas persistentes ou tentativas esgotadas deverão terminar em FALHA; isso não contará como recuperação bem-sucedida. | A |
| RNF-03 Segurança | A API deverá autenticar e autorizar acesso a dados, anexos, operações e entregas, sem vazamento entre proprietários nem mutação indevida. Sem sessão válida: HTTP 401; objeto de outro proprietário: HTTP 404. Critério: bloquear os 36 casos negativos do C03, com controles positivos. | A |

Os testes usarão duas identidades independentes e duas sessões do mesmo proprietário. Identidade de usuário e pessoa jurídica serão conceitos separados, embora a PoC limite cada espaço a uma empresa. A consulta fora do sistema ocorrerá somente sobre o pacote que o proprietário escolher compartilhar.

Requisitos Não-funcionais - continuação

| ID | Descrição | Prior. |
| --- | --- | --- |
| RNF-04 Integridade e rastreabilidade | O pacote deverá permitir verificar conteúdo e referências por um manifesto confiável externo ao pacote examinado. Critério: detectar os 20 casos de alteração, ausência, arquivo extra ou referência inválida do C04. Os hashes cobrirão HTML, CSV e anexos; não comprovarão autoria. | A |
| RNF-05 Portabilidade | O pacote deverá ser consultável offline, sem login no produto, scripts ou recursos remotos, preservando datas, acentos, valores e relações. Critério: conferir 20 registros nas combinações Windows/Firefox/LibreOffice e Linux/Chromium/LibreOffice do C05. | A |
| RNF-06 Desempenho | A geração de 200 movimentações e 50 anexos (25 MiB) deverá ter p95 ≤ 10 s em 30 medições após três aquecimentos. O pico RSS da API deverá ser ≤ 512 MiB na geração e no download sequencial. Ambiente: Linux, 2 vCPU, 4 GiB RAM, SSD local, uma geração e um download por vez (C06). | M |

O tempo de geração será medido entre o recebimento do comando pela API e o commit do pacote pronto; o download ficará fora da medida de tempo, mas integrará a medição de memória. As versões exatas, configuração do banco, máquina e carga serão fixadas no protocolo antes da coleta. A meta de 10 s deriva da decisão de oferecer retorno interativo no cenário delimitado; não é um resultado observado ou exigência institucional.

Um teste adicional no limite de 100 MiB verificará encerramento controlado, ausência de perda e registro do consumo de memória. Esse teste de limite não herdará automaticamente a meta de 10 s definida para a carga de referência.


## Cenários futuros

- C01: 100 intercalações controladas, 25 por tipo de mutação; snapshot consistente ou 409 e preservação dos bytes anteriores.
- C02: 30 execuções com uma falha transitória, 6 por cinco pontos; volume preservado e API/banco restaurados; concluir até 120 s depois da retomada. FALHA terminal não é sucesso de recuperação.
- C03: 12 operações em três condições negativas, mais 12 controles positivos; autorização, sessão e vínculos entre espaços, com CSRF válido para isolar autorização.
- C04: 20 mutações, 5 por classe, controle íntegro e controle de limitação sem referência confiável. Verificação relacional precisa ser exercitada além da comparação de bytes.
- C05: 20 registros de referência, leitura offline em Windows/Firefox/LibreOffice e Linux/Chromium/LibreOffice, versões registradas.
- C06: 200 registros, 50 anexos/25 MiB, 3 aquecimentos e 30 execuções válidas; p95 pela 29ª amostra <=10 s e RSS <=512 MiB em geração e download sequencial. Linux 2 vCPU/4 GiB/SSD. Teste adicional de 100 MiB não herda automaticamente as metas nominais.

Cada avaliação futura precisa de commit, ambiente, massa, comandos, resultado esperado/observado e evidências. Fixtures estáticas não contam como execução do aplicativo. Os pontos exatos de falha e a matriz de autorização serão detalhados em plano próprio antes da coleta formal.
