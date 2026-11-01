# API I01–I08

Node/TypeScript estrito, HTTP nativo, portas/adaptadores pg. Serve SPA compilada; /health e /ready operacionais. Sessões Argon2id/token opaco, CSRF/Origin/cookie e quotas; GET/POST de contas PF/PJ com revisão. Configuração rejeita variáveis administrativas; erros são sanitizados.

I04 acrescenta POST /api/v1/transactions: validação civil/centavos/classificação/PF empresarial, conta própria ativa, procedência MANUAL, período e pendências iniciais automáticas. Revisão e agregado persistem no mesmo commit; sessão é revalidada após bloqueios. Porta TransactionsPort e adaptador específico; valores civis/revisão e autorização/lock do espaço compartilhados com consumidores reais.

Execução em [README](../../README.md); [autenticação](../../docs/authentication.md), [contas](../../docs/accounts.md), [lançamentos](../../docs/transactions.md). Sem telas financeiras, ciclo completo de pendências, executor ou IA nesta etapa.

I05 acrescenta POST /transactions/{id}/documents: multipart limitado, PDF/PNG/JPEG5 MiB, bytes/hash imutáveis, vínculo/reconciliação/revisão atômicos e reserva de até dois uploads incluindo espera no banco. [Documentos](../../docs/documents.md). Sem download ou comandos documentais complementares.

I06 acrescenta GET /api/v1/periods/{month}/preview: seleção e revision na mesma visão REPEATABLE READ READ ONLY, totais por conta/categoria e resumo empresarial PF/PJ, documentos/pendências sem reconciliação. PreviewPort e adaptador próprio; contexto/vínculos vazios enquanto não existe fluxo de reembolso. [Escopo/limites](../../docs/implementation/I06.md). Sem UI ou migração nova.

I07 acrescenta POST /api/v1/deliveries, GET /api/v1/operations/{id} e GET /api/v1/periods/{month}/deliveries: chave idempotente consultada antes da revisão sob bloqueio do espaço, snapshot completo (`mimir.snapshot.v1`) sem incrementar revision e consultas de estado/histórico. [Escopo I07](../../docs/implementation/I07.md).

I08 acrescenta `DeliveryExecutor` (polling 2 s, lease 30 s, renovação 5 s, `fencing_token` monotônico, até 3 tentativas), empacotamento estático (`resumo.html`, `movimentacoes.csv`, `manifesto.json` v2 e `anexos/`), publicação transacional em `delivery_packages` + `PRONTA` e `GET /api/v1/deliveries/{snapshotId}/package` e `/manifest`. [Escopo I08](../../docs/implementation/I08.md).
