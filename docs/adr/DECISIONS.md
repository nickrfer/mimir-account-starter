# Decisões arquiteturais de referência

Decisões já adotadas; novas escolhas de implementação vão em docs/DECISIONS.md. A forma vigente do manifesto é v2 e inclui categoryTotals.


### ADR 001 Persistência única e custo operacional

Decisão: manter API modular e PostgreSQL 18 para dados e binários limitados. Alternativa: objetos em S3/MinIO e metadados no banco, que reduziria pressão no banco, mas acrescentaria operação e coordenação entre armazenamentos. Para esta PoC, uma fronteira transacional e implantação local simples justificam bytea. Consequências: duplicação de anexos dentro de ZIPs, crescimento de WAL/backups, ausência de política de descarte e necessidade de medir RSS. Não é solução dimensionada para grande volume.

### ADR 002 Captura idempotente e revisão global

Decisão: bloquear espaço, consultar idempotência antes de revisão e capturar agregado completo sem incrementar revision. Alternativa: revisão por mês diminuiria conflitos, mas complicaria vínculos entre meses. Revisão global pode rejeitar captura após mudança em outro mês; aceita-se esse custo. Fingerprint determinístico inclui motivo e revisão; chave existente não reinicia estado terminal.

### ADR 003 Executor durável interno

Decisão: polling, lease, token monotônico, até três tentativas e publicação atômica. Alternativa: broker e worker separado adicionariam componentes sem requisito demonstrado nesta fase. A API pode parar durante indisponibilidade; durabilidade depende de PostgreSQL e volume preservados. Recuperação em até 120 s é meta sob C02, não consequência garantida dos parâmetros. Implementar controle de executor antigo, terceira tentativa e commit ambíguo.

### ADR 004 Privilégios e configuração separados

Decisão: processo administrativo separado; API/Executor só recebem papel restrito. Segredos gerados localmente, nunca defaults ativos em código. Banco permanece em rede interna; publicação de porta administrativa, quando necessária, restrita ao loopback. API local vinculada ao loopback por padrão. Para imagem PostgreSQL 18, montagem do volume em /var/lib/postgresql, compatível com o PGDATA versionado. Fixar versões exatas, lockfile e imagens na implementação; não copiar a lista antiga do Gemini sem verificar manutenção/licenças. Compilação e caminhos de scripts devem ser exercitados numa instalação limpa.

### ADR 005 Origem de importação separada do acervo

Decisão: identidade estável e fingerprint original imutável; edição financeira não apaga procedência. Alternativa: comparar cada reimportação ao estado editado provocaria conflitos artificiais ou sobrescrita de decisões do usuário. Consequência: arquivo alterado na origem exige resolução explícita, sem merge automático. Duplicatas idênticas são ignoradas e CSV inválido rejeita lote integralmente.

### ADR 006 Pacotes autossuficientes e confiança externa

Decisão: incluir registros de contexto e todos os documentos necessários aos vínculos, diferenciando-os dos totais mensais; preservar snapshots antigos. Manifesto externo permite detectar alteração perante referência confiável, sem auto-hash. Alternativa: links para acervo vivo seriam menores, mas perderiam portabilidade e estabilidade. Consequência: anexos se repetem em entregas distintas e cópia de referência exige cuidado do usuário.

### ADR 007 Snapshot autoritativo e isolamento de relacionamentos

Decisão: snapshot JSONB completo mais referências documentais coerentes, e FKs compostas por espaço/ID. Alternativa: reconstruir a entrega consultando tabelas financeiras atuais simplificaria armazenamento, mas violaria congelamento. A representação completa exige versão de esquema, validação relacional e testes do fechamento do agregado. Índices relacionais auxiliares não podem redefinir conteúdo já capturado.

