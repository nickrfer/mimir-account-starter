# Interface web (`@mimir/web`) - I10

SPA React 19 + TypeScript + Vite que integra a primeira jornada funcional do Mimir-Account sobre a API HTTP (`/api/v1`):

- **Sessão (`POST / GET / DELETE /api/v1/session`):** hidratação automática de sessão, login com e-mail/senha provisionados por `admin create-owner`, controle de `X-CSRF-Token` e `revision` atual do espaço, e encerramento de sessão.
- **Contas PF/PJ (`GET / POST /api/v1/accounts`):** listagem e criação de contas com `expectedRevision`.
- **Lançamentos manuais (`POST /api/v1/transactions`):** conversão determinística de reais para centavos inteiros (`parseBrlCents`), regras de direção/classificação e marcação de despesa empresarial PF (`isPfBusinessExpense`).
- **Upload documental imutável (`POST /api/v1/transactions/{id}/documents`):** envio `multipart/form-data` (`file` PDF/PNG/JPEG até 5 MiB + `expectedRevision`) com reconciliação imediata de `DOCUMENTO_AUSENTE`.
- **Prévia mensal consistente (`GET /api/v1/periods/{month}/preview`):** seleção de competência (`YYYY-MM`), cartões de resumo empresarial, tabelas `cashFlowByAccount` e `categoryTotals`, movimentações principais e itens de pendência.
- **Captura imutável, fila e downloads (`POST /api/v1/deliveries`, `GET /api/v1/operations/{id}`, `GET /api/v1/periods/{month}/deliveries`, `/package` e `/manifest`):** disparo com `Idempotency-Key`, polling até `PRONTA`/`FALHA`, download direto do ZIP e do manifesto de referência v2, e comando pronto para o verificador CLI (`@mimir/verifier`).
