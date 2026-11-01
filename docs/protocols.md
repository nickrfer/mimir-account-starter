# Protocolos transacionais e operações

A forma vigente do manifesto é v2. Leia também category-totals.md; os totais por categoria são obrigatórios. Regras referenciadas por números de seção abaixo vêm da especificação de domínio, não de arquivos institucionais.


### 6.1 Revisão e captura

Toda mutação relevante autoriza os objetos, bloqueia a linha do espaço e compara expectedRevision sob esse bloqueio. Se houver mudança efetiva, incrementa revision uma vez no commit; rollback não incrementa. Comando idempotente de importação sem novas linhas não altera acervo. Leituras e transições de operações/sessões não incrementam revision. Prévia reúne dados e revisão em REPEATABLE READ READ ONLY.

Captura segue esta ordem: autenticar e validar CSRF; validar estrutura do comando; iniciar transação e bloquear espaço; procurar a chave; comparar fingerprint para chave existente; somente para chave nova comparar expectedRevision; selecionar e validar agregado; alocar versão; persistir snapshot, referências, operação EM_FILA e chave; confirmar. Uma repetição idêntica retorna a operação existente mesmo após edição do acervo ou encerramento da operação. Payload distinto retorna 409 IDEMPOTENCY_PAYLOAD_MISMATCH.

Fingerprint do comando: SHA-256 dos bytes UTF-8 de array JSON compacto [1, periodMonth, expectedRevision inteiro, rectificationReason normalizado]. O motivo sempre existe como string, inclusive vazia; NFC, quebras normalizadas e trim. Mesma representação no cliente não é pré-condição: o servidor calcula. Versão é sequencial por espaço/mês sob bloqueio e unicidade no banco. Para versão maior que 1, motivo tem 3–2.000 caracteres. Captura não incrementa revision.

Novo comando após operação FALHA também consome nova versão e exige motivo a partir da segunda versão. Não há reinício manual da operação terminal. Falha antes do commit permite repetir a chave e criar a primeira operação; falha depois do commit permite recuperá-la pela mesma chave. Não gerar ZIP dentro da transação de captura.

### 6.2 Estados e transições

| Origem | Evento e condição | Efeito atômico |
| --- | --- | --- |
| Ausente | Captura confirmada | EM_FILA, tentativa 0, token 0. |
| EM_FILA | Disponível para execução, tentativas < 3 | EM_PROCESSAMENTO; incrementa tentativa e token; lease 30 s. |
| EM_PROCESSAMENTO | Renovação com token atual e lease vigente | Prolonga lease em 30 s usando relógio do banco. |
| EM_PROCESSAMENTO | Exceção na tentativa 1 ou 2, posse ainda válida | EM_FILA; invalida posse; espera 2 s ou 5 s. |
| EM_PROCESSAMENTO | Lease expirado, tentativas < 3 | Nova aquisição incrementa tentativa e token. |
| EM_PROCESSAMENTO | Exceção válida na tentativa 3 ou lease expirado na terceira | FALHA terminal; erro sanitizado. |
| EM_PROCESSAMENTO | Publicação com estado, token e lease válidos | INSERT pacote e PRONTA no mesmo commit. |
| PRONTA ou FALHA | Repetição da mesma chave/payload | Retorna estado existente, sem transição. |

Executor interno consulta a cada 2 s e assume no máximo um trabalho por vez por processo. A implantação inicial possui uma instância de API; múltiplas instâncias não são uma capacidade validada. Renovação ocorre a cada 5 s. O algoritmo de aquisição usa bloqueio de linha e pode ignorar linhas bloqueadas; reavalia estado e prazo sob o bloqueio. A varredura deve encerrar também operações expiradas na terceira tentativa, sem deixá-las presas indefinidamente.

Heartbeat, tratamento de exceção e publicação só modificam a operação se o token ainda é atual e a posse não expirou. Ao perder a posse, cancelar leitura/compactação quando possível e descartar temporário; o executor antigo não pode reencaminhar ou marcar FALHA a execução nova. Invalidar posse na volta à fila significa limpar lease/holder e mudar estado; nova aquisição recebe token estritamente maior. PRONTA/FALHA são terminais.

Publicação bloqueia a operação e, após obter o bloqueio, verifica estado, token e lease com clock_timestamp(), não com horário fixado no início da transação. Insere ZIP/manifesto e marca PRONTA atomicamente, mantendo bloqueio até commit. O instante de validação da posse é essa checagem após o bloqueio; outra aquisição não pode ocorrer enquanto a publicação segura a linha. Não se promete computação exatamente uma vez: a compactação pode repetir, mas só uma publicação é aceita por operação.

### 6.3 Porta de persistência

| Operação lógica | Garantia exigida |
| --- | --- |
| mutateWorkspace | Autoriza, bloqueia, compara revisão, aplica domínio e pendências, incrementa uma vez se mudou, commit/rollback. |
| readPeriodPreview | REPEATABLE READ somente leitura; dados e revisão da mesma visão. |
| captureDelivery | Idempotência antes de revisão; agregado e enfileiramento atômicos. |
| claimNextOperation | Trata esgotadas; adquire operação elegível, incrementa tentativa/token e fixa lease. |
| renewLease | Atualiza somente posse vigente, usando relógio do banco. |
| readCapturedDocument | Lê um binário do snapshot por vez, validando identidade e hash. |
| publishPackage | Bloqueio, checagem de posse atual e pacote/PRONTA no mesmo commit. |
| handleAttemptFailure | Só a posse vigente pode reagendar ou encerrar; executor obsoleto não modifica a operação. |

A porta expõe operações de domínio e fronteiras transacionais, não conexão SQL genérica para o empacotador. O adaptador PostgreSQL implementará essas garantias; serviços coordenam regras, executor coordena tentativas e empacotador produz arquivos a partir do snapshot.

