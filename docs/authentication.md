# I02 — autenticação e provisionamento

## Provisionar proprietário sem senha em argumentos

Depois de setup/banco/migração conforme README, usar tarefa administrativa `create-owner`. Não existe cadastro público. A entrada é um objeto JSON UTF-8 por stdin com exatamente email, displayName, companyName e password. Resposta contém somente userId e workspaceId. Senha nova: 15–1024 caracteres, sem truncar/normalizar/remover espaços; nomes 1–200, email normalizado NFC/trim/minúsculas até 254. Duplicata falha sem alterar senha ou espaço existente. Usuário e espaço são criados na mesma transação.

No PowerShell nativo (5.1 ou 7), sem criar arquivo de senha e sem gravá-la no histórico:

```powershell
$ownerPassword = Read-Host 'Senha nova (15–1024 caracteres)' -AsSecureString
$previousEncoding = $OutputEncoding
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    $owner = @{
        email = (Read-Host 'Email')
        displayName = (Read-Host 'Nome')
        companyName = (Read-Host 'Empresa')
        password = ([System.Net.NetworkCredential]::new('', $ownerPassword)).Password
    }
    $owner | ConvertTo-Json -Compress | docker compose run --rm -T admin create-owner
    if ($LASTEXITCODE -ne 0) { throw 'Provisionamento falhou; veja código sanitizado' }
} finally {
    if ($owner) { $owner.password = $null }
    $OutputEncoding = $previousEncoding
    Remove-Variable ownerPassword,owner -ErrorAction SilentlyContinue
}
```

O exemplo requer interação do operador; não foi criado usuário pessoal automaticamente. O comando/CLI foi exercitado com entradas sintéticas geradas no processo de teste, nunca senhas literais em argumentos. Em automação, fornecer JSON por stdin a partir de fonte de segredos controlada, sem echo/transcript/log. Não adicionar JSON preenchido ao Git. O processo inevitavelmente manipula senha em memória; limpeza das variáveis não garante apagamento de todas as cópias do runtime.

## Rotas implementadas

- POST `/api/v1/session`: JSON email/password (contrato de login 1–1024 caracteres), Origin permitida; 200 com contexto e Set-Cookie. Credenciais incorretas/inexistentes/inativas retornam o mesmo 401 genérico. Login válido revoga sessão anterior apresentada pelo navegador e gera token novo, inclusive na troca de usuário.
- GET `/api/v1/session`: lê sessão ativa; 200 com userId, displayName, workspace, revision e csrfToken conforme OpenAPI; 401 para ausente, duplicada, inválida, revogada, expirada ou usuário inativo. Não renova prazo nem altera revision.
- DELETE `/api/v1/session`: sessão válida, Origin permitida e X-CSRF-Token igual ao csrfToken retornado; 204, revoga no banco e limpa cookie. Não há renovação deslizante.

Token opaco aleatório: 32 bytes, cookie hex de 64 caracteres; somente SHA-256 é persistido. CSRF também tem 32 bytes aleatórios. Prazo absoluto: 8 h medidas pelo relógio do banco, com criação/expiração obtidas do mesmo instante SQL. Runtime pode inserir/ler sessões e atualizar somente revoked_at, sem alterar identidade/token/expiração ou excluir linhas. Migração 002 reduz grants; 001 permanece intacta.

Cookie mimir_session: HttpOnly, SameSite=Lax, Path=/, Max-Age=28800; Secure por padrão. Com exceção explícita local, Origin HTTP localhost/127.0.0.1/[::1] usa cookie sem Secure; Origin HTTPS mantém Secure. Logout usa os mesmos atributos e Max-Age=0. Nenhum CORS genérico é habilitado.

## Configuração local e segurança

Compose local define `ALLOW_LOCAL_HTTP=true` e origens exatas 127.0.0.1/localhost nas portas 3000/5173. Ajustáveis em .env comum, sem segredos:

```dotenv
MIMIR_ALLOWED_ORIGINS=http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:5173,http://localhost:5173
MIMIR_ALLOW_LOCAL_HTTP=true
```

Ao trocar porta publicada, ajustar origens correspondentes. Configuração Node direta aceita APP_ORIGINS/ALLOW_LOCAL_HTTP em .env.runtime; sem exceção explícita, só HTTPS é aceito (padrão https://localhost). Origin com caminho, credenciais, wildcard ou HTTP público é rejeitada. Para instalação HTTPS futura, desabilitar exceção e fornecer origem HTTPS exata. TLS/proxy de produção não foram implantados ou testados nesta etapa.

Login limita corpo a 8 KiB, UTF-8 válido, somente application/json e campos exatos. Token de cookie duplicado é rejeitado. Nunca usar workspaceId enviado pelo cliente para decidir identidade. IP vem do socket TCP; X-Forwarded-For não é confiável e é ignorado. Atrás do Vite, IP observado é o do proxy, sem promessa de identificar IP original.

Limite por conta normalizada/IP: 5 falhas de credenciais por janela de 15 min, com reservas concorrentes e resposta 429/Retry-After. Máximo 2 verificações Argon2 simultâneas, sem fila ilimitada; saturação retorna 429 com 1 s. Até 10000 combinações em memória; janela expirada é removida e saturação bloqueia conservadoramente. Falha de infraestrutura não consome nem zera contador de credenciais. Reiniciar API limpa contadores em memória, mas sessões permanecem no PostgreSQL; não há bloqueio distribuído/persistente alegado.

Argon2id via @node-rs/argon2 2.2.2 MIT: 65536 KiB, 3 passagens, paralelismo 1, saída 32 bytes e salt aleatório. PHC com parâmetros fora dessa política é rejeitado; login usa hash dummy quando usuário/hash não é utilizável. Mudança futura de política exige estratégia explícita de migração/compatibilidade. Medição local sanitizada está em docs/evidence/I02-argon2.json; não é experimento C01–C06 ou garantia de desempenho.

Logs contêm somente requestId, operação, status e duração; erros HTTP contêm code, message e requestId. Sem credenciais, corpo, cookies, CSRF, email ou SQL. Falha de banco retorna 500 genérico na sessão, com readiness 503. Administração continua fora do processo API.

## Limites

Sem UI de login, alteração de senha, recuperação de conta, MFA, IA ou usuário padrão. Testes usam somente identidades sintéticas. I03 acrescentou [contas/revisão](accounts.md), reutilizando sessão, CSRF e helpers HTTP seguros; demais comandos financeiros aguardam seus incrementos. Host Linux não é requisito para avançar usando Docker Desktop do Windows.
