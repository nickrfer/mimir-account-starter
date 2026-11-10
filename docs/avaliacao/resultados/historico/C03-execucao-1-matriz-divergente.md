# Resultado C03 - Segurança e isolamento (RNF-03)

Veredito: **atende** ao critério: Bloquear os 36 casos negativos (12 operações × 3 condições) com 12 controles positivos aceitos, sem vazamento nem mutação (RNF-03).

- Commit `d12005c7a407948a5a055fe25ccd881b28b1eb34` (tag `poc-v1.0.0`; produto igual à tag: sim); projeto Docker `mimir-eval-c03-132fb6ad`; Docker 29.9.2; PostgreSQL 18.6 (Debian 18.6-1.pgdg12+2); Node v24.22.1.
- API: ponto de entrada real (`apps/api/dist/index.js`, executor embutido) em processo filho com apenas as variáveis de runtime; identidades A (sessões A1, A2) e B independentes; CSRF válido em todas as mutações.
- Negativos: 36/36 bloqueados (N1 sem sessão, N2 outro proprietário, N3 vínculo entre espaços); adicional N1 com sessão revogada: 12/12.
- Positivos: 12/12 aceitos.
- "Inalterado" compara revisão, contagens e conteúdo dos dois espaços antes e depois de cada caso negativo.

| Operação | Condição | Esperado | Observado | Inalterado | Resultado |
| --- | --- | --- | --- | --- | --- |
| GET /transactions/{id} | N1-sem-sessao | 401 | 401 AUTH_REQUIRED | sim | ok |
| GET /transactions/{id} | N1-sessao-revogada | 401 | 401 AUTH_REQUIRED | sim | ok |
| GET /transactions/{id} | N2-outro-proprietario | 404 | 404 NOT_FOUND | sim | ok |
| GET /transactions/{id} | N3-vinculo-entre-espacos | 200 | 200 | sim | ok |
| PATCH /transactions/{id} | N1-sem-sessao | 401 | 401 AUTH_REQUIRED | sim | ok |
| PATCH /transactions/{id} | N1-sessao-revogada | 401 | 401 AUTH_REQUIRED | sim | ok |
| PATCH /transactions/{id} | N2-outro-proprietario | 404 | 404 NOT_FOUND | sim | ok |
| PATCH /transactions/{id} | N3-vinculo-entre-espacos | 404 | 404 NOT_FOUND | sim | ok |
| DELETE /transactions/{id} | N1-sem-sessao | 401 | 401 AUTH_REQUIRED | sim | ok |
| DELETE /transactions/{id} | N1-sessao-revogada | 401 | 401 AUTH_REQUIRED | sim | ok |
| DELETE /transactions/{id} | N2-outro-proprietario | 404 | 404 NOT_FOUND | sim | ok |
| DELETE /transactions/{id} | N3-vinculo-entre-espacos | 404 | 404 NOT_FOUND | sim | ok |
| POST /transactions/{id}/documents | N1-sem-sessao | 401 | 401 AUTH_REQUIRED | sim | ok |
| POST /transactions/{id}/documents | N1-sessao-revogada | 401 | 401 AUTH_REQUIRED | sim | ok |
| POST /transactions/{id}/documents | N2-outro-proprietario | 404 | 404 NOT_FOUND | sim | ok |
| POST /transactions/{id}/documents | N3-vinculo-entre-espacos | 404 | 404 NOT_FOUND | sim | ok |
| GET /documents/{id}/content | N1-sem-sessao | 401 | 401 AUTH_REQUIRED | sim | ok |
| GET /documents/{id}/content | N1-sessao-revogada | 401 | 401 AUTH_REQUIRED | sim | ok |
| GET /documents/{id}/content | N2-outro-proprietario | 404 | 404 NOT_FOUND | sim | ok |
| GET /documents/{id}/content | N3-vinculo-entre-espacos | 200 | 200 | sim | ok |
| POST /transactions/{id}/document-replacements | N1-sem-sessao | 401 | 401 AUTH_REQUIRED | sim | ok |
| POST /transactions/{id}/document-replacements | N1-sessao-revogada | 401 | 401 AUTH_REQUIRED | sim | ok |
| POST /transactions/{id}/document-replacements | N2-outro-proprietario | 404 | 404 NOT_FOUND | sim | ok |
| POST /transactions/{id}/document-replacements | N3-vinculo-entre-espacos | 404 | 404 NOT_FOUND | sim | ok |
| PATCH /pending-items/{id} | N1-sem-sessao | 401 | 401 AUTH_REQUIRED | sim | ok |
| PATCH /pending-items/{id} | N1-sessao-revogada | 401 | 401 AUTH_REQUIRED | sim | ok |
| PATCH /pending-items/{id} | N2-outro-proprietario | 404 | 404 NOT_FOUND | sim | ok |
| PATCH /pending-items/{id} | N3-vinculo-entre-espacos | 200 | 200 | sim | ok |
| GET /periods/{m}/preview | N1-sem-sessao | 401 | 401 AUTH_REQUIRED | sim | ok |
| GET /periods/{m}/preview | N1-sessao-revogada | 401 | 401 AUTH_REQUIRED | sim | ok |
| GET /periods/{m}/preview | N2-outro-proprietario | 200 | 200 | sim | ok |
| GET /periods/{m}/preview | N3-vinculo-entre-espacos | 404 | 404 NOT_FOUND | sim | ok |
| GET /operations/{id} | N1-sem-sessao | 401 | 401 AUTH_REQUIRED | sim | ok |
| GET /operations/{id} | N1-sessao-revogada | 401 | 401 AUTH_REQUIRED | sim | ok |
| GET /operations/{id} | N2-outro-proprietario | 404 | 404 NOT_FOUND | sim | ok |
| GET /operations/{id} | N3-vinculo-entre-espacos | 200 | 200 | sim | ok |
| GET /deliveries/{id}/package | N1-sem-sessao | 401 | 401 AUTH_REQUIRED | sim | ok |
| GET /deliveries/{id}/package | N1-sessao-revogada | 401 | 401 AUTH_REQUIRED | sim | ok |
| GET /deliveries/{id}/package | N2-outro-proprietario | 404 | 404 NOT_FOUND | sim | ok |
| GET /deliveries/{id}/package | N3-vinculo-entre-espacos | 404 | 404 NOT_FOUND | sim | ok |
| POST /reimbursements | N1-sem-sessao | 401 | 401 AUTH_REQUIRED | sim | ok |
| POST /reimbursements | N1-sessao-revogada | 401 | 401 AUTH_REQUIRED | sim | ok |
| POST /reimbursements | N2-outro-proprietario | 404 | 404 NOT_FOUND | sim | ok |
| POST /reimbursements | N3-vinculo-entre-espacos | 404 | 404 NOT_FOUND | sim | ok |
| DELETE /transactions/{id}/document-links/{documentId} | N1-sem-sessao | 401 | 401 AUTH_REQUIRED | sim | ok |
| DELETE /transactions/{id}/document-links/{documentId} | N1-sessao-revogada | 401 | 401 AUTH_REQUIRED | sim | ok |
| DELETE /transactions/{id}/document-links/{documentId} | N2-outro-proprietario | 404 | 404 NOT_FOUND | sim | ok |
| DELETE /transactions/{id}/document-links/{documentId} | N3-vinculo-entre-espacos | 404 | 404 NOT_FOUND | sim | ok |
| GET /transactions/{id} | A2-segunda-sessao | 200 | 200 | - | ok |
| PATCH /transactions/{id} | A1 | 200 | 200 | - | ok |
| POST /transactions/{id}/documents | A1 | 201 | 201 | - | ok |
| GET /documents/{id}/content | A2-segunda-sessao | 200 | 200 | - | ok |
| POST /transactions/{id}/document-replacements | A1 | 201 | 201 | - | ok |
| PATCH /pending-items/{id} | A1 | 200 | 200 | - | ok |
| GET /periods/{m}/preview | A2-segunda-sessao | 200 | 200 | - | ok |
| GET /operations/{id} | A2-segunda-sessao | 200 | 200 | - | ok |
| GET /deliveries/{id}/package | A2-segunda-sessao | 200 | 200 | - | ok |
| POST /reimbursements | A1 | 201 | 201 | - | ok |
| DELETE /transactions/{id}/document-links/{documentId} | A1 | 200 | 200 | - | ok |
| DELETE /transactions/{id} | A1 | 200 | 200 | - | ok |
