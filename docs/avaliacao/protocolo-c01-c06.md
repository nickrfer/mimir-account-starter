# Protocolo da avaliação formal C01–C06

Plano exigido por `docs/requirements.md` ("Os pontos exatos de falha e a matriz de autorização serão detalhados em plano próprio antes da coleta formal"). Fixado **antes** da coleta. Contagens, metas e cenários vêm de `docs/requirements.md` (RNF-01 a RNF-06 e C01–C06); este documento só detalha procedimento, massa, controles e evidência.

## 1. Objeto avaliado e regras gerais

- **Versão**: tag `poc-v1.0.0` (commit `14605c6`), I01–I16. Correção encontrada durante a coleta gera nova tag (`poc-v1.0.x`), registro em `docs/DECISIONS.md` e **repetição integral** do cenário afetado; resultados de versões diferentes não se misturam.
- **Ambiente base**: Windows 11 Pro com Docker Desktop (WSL2, kernel Linux), PostgreSQL 18 e API em contêineres do `compose.yaml`, projeto e volume **novos por cenário**, banco sem porta no host. Versões exatas (Docker, WSL, PostgreSQL, Node, navegadores, LibreOffice) e hardware (CPU, RAM, disco) são registrados no resultado de cada cenário.
- **Massa**: sintética, gerada por script versionado com semente fixa; nenhum dado real. Credenciais de teste geradas por execução e gravadas apenas em `.local/`.
- **Harness**: scripts em `tools/avaliacao/`, executados contra a API real por HTTP e o banco real; nenhuma regra de produto é contornada (a única exceção declarada é a injeção de falha do C02, ver §3).
- **Evidência por cenário**: `docs/avaliacao/resultados/Cxx.json` (sanitizado: ids sintéticos, contagens, tempos, códigos, hashes; sem credenciais, cookies ou conteúdo financeiro além do sintético) e `docs/avaliacao/resultados/Cxx.md` (ambiente, comandos, resultado esperado e observado, desvios, ameaças). Logs brutos ficam em `.local/avaliacao/`.
- **Resultado**: cada cenário declara **atende** / **não atende** ao critério de `requirements.md`. Um caso que não atende é reportado como tal; não se reexecuta seletivamente para "passar". Execuções inválidas (falha do próprio harness, não do produto) são registradas com motivo e substituídas; o número de substituições é publicado.

## 2. C01 — Consistência da captura (RNF-01)

**Critério**: nenhuma mistura de revisões nas 100 intercalações; cada captura resulta em snapshot consistente **ou** 409 sem nova versão, e os bytes de entregas anteriores são preservados.

**Massa por execução**: espaço novo com contas PF e PJ, 6 lançamentos no mês (receita, despesas com e sem documento, despesa PF empresarial, transferência), 1 documento e 1 pendência; uma entrega v1 capturada e publicada antes da intercalação (referência de bytes).

**Tipos de mutação (4 × 25)**:

| Tipo | Mutação |
| --- | --- |
| M1 | Correção de valor de lançamento (`PATCH /transactions/{id}`) |
| M2 | Upload de documento em lançamento sem comprovante |
| M3 | Vínculo de reembolso PF→PJ (`POST /reimbursements`) |
| M4 | Justificativa de pendência (`PATCH /pending-items/{id}`) |

**Intercalação controlada**: o harness lê a revisão R, segura a linha do espaço por uma conexão administrativa (`SELECT ... FOR UPDATE`) e dispara em paralelo a captura (`expectedRevision=R`) e a mutação (`expectedRevision=R`); libera o bloqueio após ambas estarem aguardando o lock (verificado em `pg_stat_activity`). Para cada tipo, as 25 execuções se dividem em 12 com a mutação enfileirada primeiro e 13 com a captura enfileirada primeiro (ordem de chegada ao lock controlada por espera ativa); o vencedor real é registrado.

**Verificações por execução**: (a) exatamente uma das duas operações com revisão R vence; a outra recebe 409 `REVISION_CONFLICT`; (b) se a captura venceu, o payload do snapshot é idêntico (canonicalizado) ao estado lido antes da mutação, e o pacote publicado passa no verificador offline; (c) se a mutação venceu, nenhuma versão nova existe e uma captura posterior com a revisão nova reflete a mutação; (d) o ZIP e o manifesto da v1 são byte a byte iguais aos baixados antes; (e) a revisão final é coerente (R+1 com mutação vencedora, R sem).

## 3. C02 — Recuperação (RNF-02)

**Critério**: 30 execuções com uma falha transitória (6 por ponto); concluir em PRONTA, sem versão duplicada nem pacote parcial, em até 120 s após restabelecer API e banco. FALHA terminal não conta como recuperação.

**Pontos de falha** (operações reais da porta do executor):

| Ponto | Momento | Falha injetada |
| --- | --- | --- |
| P1 | antes de `claimNextOperation` concluir | banco parado (`docker stop db`) e reiniciado |
| P2 | em `readSnapshot` | banco parado e reiniciado |
| P3 | em `readCapturedDocument` (montagem do ZIP) | banco parado e reiniciado |
| P4 | em `publishPackage` (antes do commit) | banco parado e reiniciado |
| P5 | durante a montagem, com lease ativo | processo da API encerrado (`docker kill api`) e reiniciado; nova tentativa após expiração do lease |

**Injeção, sem alterar o produto**: o executor de produção (`DeliveryExecutor` com `PostgresExecutor`, mesmo código) roda num processo Node próprio do harness, restrito ao espaço do teste pelo parâmetro `scope` do adaptador, e com a porta envolvida por um decorador que, no ponto Pn, sinaliza ao harness e aguarda. O harness então provoca a falha real (`docker stop` do banco), restaura (`docker start`, espera `pg_isready`) e libera o processo, que encontra a conexão perdida e segue o tratamento normal de tentativa, lease e repetição. Em P5 o harness encerra o processo do executor (`SIGKILL`) durante a montagem e inicia outro; a nova aquisição só ocorre após a expiração do lease (30 s). A API HTTP do cenário roda sem executor embutido (aplicação montada pelo harness com `createApp`, como nos testes de integração), para que só o executor instrumentado processe as operações. Desvio declarado: o executor roda fora do processo da API; o código, a porta, o banco e o protocolo de lease são os de produção.

**Verificações**: estado final PRONTA; tempo entre "API e banco saudáveis de novo" (`/ready` 200) e PRONTA ≤ 120 s; exatamente uma linha em `delivery_packages` por snapshot; nenhuma versão extra; pacote verificado offline; volume preservado; `attempt_count ≤ 3`. Execução que termina em FALHA é contada como não recuperada.

## 4. C03 — Segurança e isolamento (RNF-03)

**Critério**: bloquear os 36 casos negativos (12 operações × 3 condições), com 12 controles positivos aceitos; sem vazamento nem mutação indevida.

**Identidades**: A e B (proprietários independentes) e duas sessões de A (A1, A2). CSRF válido em todas as mutações, para isolar autorização de CSRF.

**Operações** (objetos de A): (1) `GET /transactions/{id}`; (2) `PATCH /transactions/{id}`; (3) `DELETE /transactions/{id}`; (4) `POST /transactions/{id}/documents`; (5) `GET /documents/{id}/content`; (6) `POST /transactions/{id}/document-links`; (7) `GET /periods/{m}/preview`; (8) `POST /deliveries`; (9) `GET /operations/{id}`; (10) `GET /deliveries/{id}/package`; (11) `PATCH /pending-items/{id}`; (12) `POST /reimbursements`.

**Condições negativas**: N1 sem sessão (ou sessão revogada) → 401; N2 sessão de B sobre objeto de A → 404 sem distinção de inexistente; N3 vínculo entre espaços (objeto de A referenciado a partir de B: conta, documento, lançamento ou entrega de A dentro de comando de B) → 404/422 sem efeito. **Controles positivos**: as mesmas 12 operações por A1 (e leitura por A2) → sucesso.

**Verificações**: status esperado; contagem de linhas e revisão de A e B iguais antes/depois de cada negativo; corpo de erro sem dados do outro espaço.

## 5. C04 — Integridade e rastreabilidade do pacote (RNF-04)

**Critério**: detectar os 20 casos (5 por classe) com o verificador offline e uma referência confiável externa; controle íntegro aceito; controle de limitação sem referência confiável documentado.

**Base**: entrega publicada com 3 documentos, contexto de reembolso e pendências; manifesto de referência baixado pela API (`/manifest`) e guardado fora do pacote.

| Classe | Mutações (5 cada) |
| --- | --- |
| Alteração | 1 byte de anexo PDF; 1 byte de anexo PNG; texto do `resumo.html`; valor no `movimentacoes.csv`; campo do `manifesto.json` dentro do pacote |
| Ausência | remover um anexo; remover `resumo.html`; remover `movimentacoes.csv`; remover o anexo de contexto; remover `manifesto.json` do pacote |
| Arquivo extra | arquivo em `anexos/`; arquivo na raiz; subdiretório novo; cópia de anexo com outro nome; link simbólico |
| Referência inválida | (manifesto de laboratório e referência preparados com a mesma inconsistência e hashes válidos) documento referenciado inexistente; vínculo de reembolso para lançamento ausente; pendência para lançamento ausente; `categoryTotals` incoerente; arquivo com papel trocado |

**Controles**: (C+) pacote íntegro com a referência → código 0; (C-lim) pacote alterado verificado contra o próprio manifesto alterado → aceito, demonstrando que a garantia depende da referência externa (limitação esperada, não falha).

**Verificações**: código de saída 1 e código de diagnóstico coerente com a classe em todos os 20; nenhum falso positivo no C+.

## 6. C05 — Portabilidade offline (RNF-05)

**Critério**: conferir 20 registros nas combinações Windows/Firefox/LibreOffice e Linux/Chromium/LibreOffice, preservando datas, acentos, valores e relações, offline e sem login.

**Massa**: entrega com 20 lançamentos de referência cobrindo acentos e caracteres especiais, valores de 1 centavo a bilhões, PF/PJ, reembolso entre meses, pendências justificadas e documentos; oráculo dos 20 registros gerado do snapshot (`referencia-c05.csv`).

**Execução**: Windows — Firefox abre `resumo.html` via `file://` com rede desabilitada; LibreOffice Calc (headless) converte `movimentacoes.csv` (UTF-8, vírgula) para planilha e exporta os valores. Linux (WSL2) — Chromium headless e LibreOffice headless no mesmo procedimento. Instalação de cada ferramenta só com autorização explícita do usuário. O harness extrai os valores exibidos (texto do HTML e células do CSV convertido) e monta a planilha de conferência; **o usuário confere os 20 registros** e registra a decisão por registro.

**Verificações**: 20/20 registros iguais ao oráculo em data, descrição acentuada, valor, conta/tipo, categoria, documentos e vínculos, nas duas combinações; nenhuma requisição de rede (HTML com CSP `default-src 'none'`); versões registradas.

## 7. C06 — Desempenho (RNF-06)

**Critério**: geração de 200 movimentações com 50 anexos (25 MiB) com p95 ≤ 10 s (29ª amostra ordenada de 30) após 3 aquecimentos; pico de RSS da API ≤ 512 MiB na geração e no download sequencial; uma geração e um download por vez.

**Ambiente (desvio declarado)**: contêineres da API e do banco limitados a 2 CPUs e 4 GiB (`cpus: 2`, `mem_limit: 4g`) no Docker Desktop/WSL2 do Windows, não um host Linux dedicado; disco é o SSD local da máquina. Registrar CPU e RAM físicas e a carga concorrente (nenhuma outra bateria em execução).

**Massa**: 200 lançamentos no mês e 50 PDFs sintéticos de 524.288 bytes (25 MiB), semente fixa.

**Medição**: tempo = `delivery_packages.published_at` − `delivery_operations.created_at` (relógio do banco, entre o recebimento do comando e o commit do pacote). Cada amostra é uma nova versão (captura com motivo) sobre o mesmo mês; download sequencial do ZIP após cada geração. RSS: `VmHWM` do processo Node da API (`/proc/<pid>/status`) amostrado a cada 100 ms durante geração e download, reiniciando o contêiner da API entre o aquecimento e a série para isolar o pico. 3 aquecimentos descartados; 30 amostras válidas.

**Teste de limite (100 MiB)**: 200 anexos de 512 KiB (100 MiB); verificar conclusão controlada ou falha controlada, ausência de perda e registro do RSS; sem meta de tempo.

## 8. Ameaças à validade

C06 em Docker limitado sobre WSL2, não host dedicado; C02 roda o executor fora do processo da API e pausa por decorador do harness; C05 conferido pelo próprio autor; harness escrito pelo mesmo autor do produto (mitigado por oráculos independentes, verificador offline e critérios fixados antes da coleta); dados sintéticos.

## 9. Ordem de execução

C03 → C04 → C01 → C02 → C05 → C06 (do mais automatizável ao que exige ambiente e conferência).

## Errata

### E1 — C01, verificação (a) — 02/11/2026, durante a coleta

A verificação derivada "(a) exatamente uma das duas operações com revisão R vence; a outra recebe 409" contradiz o desenho documentado antes deste protocolo: a captura **não incrementa** a revisão (constituição, Princípio III; `docs/protocols.md` §6.1). Logo, quando a captura é atendida primeiro, a mutação seguinte com a mesma revisão R é legitimamente aceita e leva o espaço a R+1, sem afetar o snapshot já capturado.

Detectada na primeira execução completa do C01 (`mimir-eval-c01-bb8b62c5`): 48/100 aprovadas; as 52 reprovadas são exatamente as execuções com a captura atendida primeiro, todas com snapshot consistente com R, pacote verificado e v1 preservada. Essa execução é mantida íntegra em `resultados/historico/C01-execucao-1-checagem-derivada-incorreta.{json,md}`.

O critério de `docs/requirements.md` (nenhuma mistura; snapshot consistente ou 409; bytes anteriores preservados) **não muda**. Verificações corrigidas por ordem atendida:

- **Captura atendida primeiro**: captura 202 com `capturedRevision = R` e manifesto igual à prévia em R; pacote verificado; mutação com R aceita em seguida; revisão final R+1; uma versão nova.
- **Mutação atendida primeiro**: mutação aceita; captura com R recusada com 409 `REVISION_CONFLICT`; nenhuma versão nova; captura seguinte igual à prévia em R+1.
- **Em ambos**: v1 byte a byte igual. Qualquer outra combinação reprova.

O C01 é repetido integralmente com as verificações corrigidas.

### E2 — C06, nome da coluna de medição — 02/11/2026, antes da coleta do C06

A §7 cita `delivery_packages.published_at`; a coluna real do instante de publicação é `delivery_packages.created_at` (migração 007), gravada no mesmo commit que marca a operação PRONTA. A medição é a mesma: `delivery_packages.created_at − delivery_operations.created_at`, no relógio do banco.

### E3 — C05, combinação Windows — 02/11/2026, durante a coleta, por decisão do usuário

A instalação do LibreOffice no Windows (winget, autorizada) ficou aguardando elevação de privilégio e foi cancelada por decisão do usuário. A combinação Windows/Firefox/LibreOffice é executada **sem o LibreOffice**: no Windows, o resumo é aberto no Firefox offline; a leitura do `movimentacoes.csv` por planilha é conferida apenas no LibreOffice do lado Linux (contêiner Debian 12, LibreOffice 7.4.7.2, sem rede). Desvio declarado; o C05 é reportado como atendido apenas com esse desvio. Nenhuma biblioteca substitui o LibreOffice na conferência.

### E4 — C03, matriz executada — 02/11/2026, após a coleta, na revisão do harness

A matriz executada difere da §4 em duas operações: no lugar de (6) `POST /transactions/{id}/document-links` e (8) `POST /deliveries`, o harness testou `POST /transactions/{id}/document-replacements` e `DELETE /transactions/{id}/document-links/{documentId}`. `POST /transactions/{id}/document-links` aparece apenas como caso N3 de outra operação, e **`POST /deliveries` não foi testado sem sessão nem por outro proprietário**. Além disso, 5 dos 36 casos só reprovariam por vazamento de identificador, não por status: o N2 da prévia (B lê a própria prévia, 200) e o N3 de quatro leituras (B lista os próprios lançamentos, documentos, pendências e entregas, 200). O resultado 36/36 vale para a matriz executada, listada em `resultados/C03.md`. O cenário não foi repetido.

### E5 — C02, âncora do tempo de recuperação — 02/11/2026, após a coleta, na revisão do harness

A §3 mede a partir de `/ready` 200. O harness ancorou em `clock_timestamp()` lido pelo driver depois que o orquestrador concluiu `docker compose up --wait db` (healthcheck a cada 2 s) e sinalizou por arquivo (varredura a cada 100 ms). O banco aceita conexões antes disso, então a âncora fica atrasada em relação à restauração real e os tempos estão subestimados em até cerca de 2 s (**INFERIDO** pelo intervalo do healthcheck). No P1 o executor publicou antes da âncora (de −1,2 a −0,5 s). O veredito não muda: maior tempo 28,3 s, meta 120 s.
