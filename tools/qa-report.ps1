param([Parameter(Mandatory=$true)][ValidatePattern('^mimir-docker-[a-f0-9]{10}$')][string]$Project)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$directory=Join-Path $root ".local/$Project"
$summaryPath=Join-Path $root "docs/evidence/docker-$Project.json"
$summary=Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
if($summary.project -ne $Project){throw 'Projeto divergente na evidencia'}
$log=Get-Content -LiteralPath (Join-Path $directory 'run.log') -Raw
function Count-Result([string]$label){
    $matches=[regex]::Matches($log,"(?m)^.*?\b$label (\d+)\s*$")
    if($matches.Count){return [int]$matches[$matches.Count-1].Groups[1].Value};return $null
}
$cases=@(
    @{id='QA-01';title='Build, migracoes e testes PostgreSQL';stage='unit-and-postgresql';proof='Testes executados no container; inclui privilegios, integridade, upload e rollback.'},
    @{id='QA-02';title='Login, conta, lancamento e upload na API real';stage='session-create-real-api';proof='Sonda HTTP autenticada e SQL administrativo separado; sem tela financeira.'},
    @{id='QA-03';title='Persistencia apos recriar banco e API';stage='session-persisted-after-recreate';proof='IDs, bytes/hash, vinculo, pendencias, revisao e sessao conferidos pela sonda.'},
    @{id='QA-04';title='Ausencia de credenciais administrativas na API';stage='api-environment';proof='Auditoria no processo real e arquivos da imagem.'},
    @{id='QA-05';title='Vite, proxy e hot reload';stage='vite-proxy-hmr';proof='Resposta HTTP e mensagem WebSocket HMR; nao e screenshot.'}
)
if($log.Contains('I06 preview: actual HTTP and PostgreSQL')){
    $cases+=@{id='QA-I06';title='Previa mensal consistente: HTTP e PostgreSQL';stage='unit-and-postgresql';
        proof='Dados sinteticos I06: esperado isolamento REPEATABLE READ READ ONLY, revisao/dados da mesma visao sob commit concorrente, ausencia de escrita, autorizacao, totais PF/PJ/categorias, documentos/pendencias e limites sem truncamento. Resultado observado pela suite desta rodada; detalhes dos criterios e limites em docs/evidence/I06.md. Contexto/vinculos vazios porque reembolsos ainda nao foram implementados; sem prova de UI.'}
}
if($log.Contains('I07 capture: HTTP and real PostgreSQL')){
    $cases+=@{id='QA-I07';title='Captura imutavel, idempotencia e fila persistida';stage='unit-and-postgresql';
        proof='Fixtures sinteticas I07: esperado snapshot/referencias/EM_FILA/chave no mesmo commit, idempotencia antes da revisao, versoes sequenciais, ausencia de incremento de revisao, isolamento entre proprietarios, fechamento diferido/FKs/imutabilidade e rollback nos estagios. Resultado observado pela suite desta rodada; criterios/limites em docs/evidence/I07.md. Sonda da API real confere captura/repeticao/estado/historico antes/depois da recriacao. Sem executor, pacote ou prova de UI.'}
}
if($log.Contains('I08 executor: leases, fencing, publication and downloads on real PostgreSQL')){
    $cases+=@{id='QA-I08';title='Executor, lease/fencing e pacote publicado';stage='unit-and-postgresql';
        proof='Fixtures sinteticas I08: esperado aquisicao com token monotonico, renovacao so com posse vigente, retomada apos lease expirado, retry de 2 s e 5 s, FALHA terminal na terceira tentativa ou lease expirado, publicacao do pacote e PRONTA no mesmo commit, executor obsoleto sem efeito, ZIP/manifesto sem reserializacao a partir do snapshot, downloads por proprietario, limpeza de temporarios e grants/gatilhos do banco. Sonda da API real aguarda PRONTA, baixa ZIP/manifesto e confere hashes antes/depois da recriacao. Resultado observado pela suite desta rodada; criterios e limites em docs/evidence/I08.md. Sem verificador, UI ou prova visual.'}
}
if($log.Contains('I08 packaging: CSV neutralisation')){
    $cases+=@{id='QA-I08-PKG';title='Empacotamento: CSV, HTML, manifesto e ZIP';stage='unit-and-postgresql';
        proof='Testes unitarios I08 com dados sinteticos: neutralizacao de formula no CSV, escape do HTML sem conteudo ativo, manifesto v2 com hashes dos arquivos, ZIP legivel com CRC, falha por documento adulterado, aborto, limite de manifesto e de ZIP. Resultado observado pela suite desta rodada.'}
}
if($log.Contains('I09 verifier: accepts the 3 synthetic v2 fixtures')){
    $cases+=@{id='QA-I09';title='Verificador CLI independente: fixtures v2, controles semanticos e pacote real';stage='verifier-package';
        proof='Fixtures sinteticas v2 (outubro_v1, novembro_v1, outubro_v2) + ORACULOS_DOS_EXEMPLOS + pacote real publicado pelo executor em PostgreSQL: esperado aceite (codigo 0) dos 3 casos oficiais e do pacote real extraido no container isolado verifier (network_mode: none, read_only: true), erro de uso/autorreferencia (codigo 2), e rejeicao deterministica (codigo 1) para divergencia de bytes do manifesto, schemaVersion v1, violacoes de schema, todos os 18 controles de categoryTotals/summary, 14 controles relacionais, arquivos faltantes/extras/adulterados, symlinks, HTML ativo e adulteracao de CSV, sem vazar descricoes privadas. Resultado observado nesta rodada; detalhes em docs/evidence/I09.md.'}
}
$hasStages=$null -ne $summary.PSObject.Properties['completedStages']
foreach($case in $cases){
    $case.result=if($hasStages -and $summary.completedStages -contains $case.stage){'passou'}elseif($summary.failureStage -eq $case.stage){'falhou'}else{'nao-executado'}
    if(!$hasStages){$case.proof+=' Rodada antiga sem etapas detalhadas; cobertura deste cenario nao inferida.'}
}
$screens=@()
$reviewPath=Join-Path $directory 'screenshots/review.json'
if(Test-Path -LiteralPath $reviewPath){
    foreach($entry in @(Get-Content -LiteralPath $reviewPath -Raw | ConvertFrom-Json)){
        if($entry.reviewed -ne $true -or $entry.synthetic -ne $true){continue}
        if($entry.file -notmatch '^[a-zA-Z0-9_-]+\.png$' -or !$entry.caption -or !$entry.scenario){throw 'Screenshot sem nome seguro, legenda ou cenario'}
        if(!(Test-Path -LiteralPath (Join-Path $directory "screenshots/$($entry.file)"))){throw 'Screenshot ausente'}
        $screens+=@{file="screenshots/$($entry.file)";caption=[string]$entry.caption;scenario=[string]$entry.scenario}
        if($cases.id -notcontains [string]$entry.scenario){
            $cases+=@{id=[string]$entry.scenario;title='Estado visual observado (origem na legenda)';stage='visual-review';result='passou';proof=[string]$entry.caption}
        }
    }
}
$result=[ordered]@{schemaVersion=1;project=$Project;generatedAt=[DateTime]::UtcNow.ToString('o');source="docs/evidence/docker-$Project.json";dataOrigin='synthetic';passed=[bool]$summary.passed;tests=(Count-Result 'tests');testsPassed=(Count-Result 'pass');testsFailed=(Count-Result 'fail');stepsPassed=$summary.stepsPassed;failureStage=$summary.failureStage;volumeRemoved=$summary.volumeRemoved;scenarios=$cases;screenshots=$screens;limits=@('Interface atual e somente shell; upload financeiro comprovado por HTTP/PostgreSQL.','Screenshots nao solicitados/coletados ficam ausentes; nao equivalem a cenario aprovado.','Logs brutos/configuracao/trace/cookies nao sao incluidos neste relatorio.','QA-01 a QA-05 deste relatorio sao cenarios locais; nao sao os experimentos academicos C01-C06.')}
[IO.File]::WriteAllText((Join-Path $directory 'qa.json'),($result|ConvertTo-Json -Depth 7),[Text.UTF8Encoding]::new($false))
function Escape-Html([object]$v){[Net.WebUtility]::HtmlEncode([string]$v)}
$labels=@{passou='Passou';falhou='Falhou';'nao-executado'='Não executado'}
$styles=@{passou='';falhou='fail';'nao-executado'='pending'}
$rows=($cases|ForEach-Object {
    $label=$labels[$_.result];$style=$styles[$_.result]
    "<details class='scenario'><summary><span class='scenario-title'><span class='scenario-id'>$(Escape-Html $_.id)</span>$(Escape-Html $_.title)</span><span class='scenario-right'><span class='badge $style'>$label</span><span class='chevron' aria-hidden='true'>›</span></span></summary><div class='proof'><div class='eyebrow'>Prova observada e limite</div>$(Escape-Html $_.proof)</div></details>"
}) -join "`n"
$images=($screens|ForEach-Object {
    $bytes=[IO.File]::ReadAllBytes((Join-Path $directory $_.file))
    $imageUri='data:image/png;base64,'+[Convert]::ToBase64String($bytes)
    $downloadName=[IO.Path]::GetFileName($_.file)
    "<figure class='capture'><div class='capture-top'><span>$(Escape-Html $_.scenario) · PNG original</span><span class='badge'>Revisão visual registrada</span></div><a class='image-link' href='$imageUri' download='$(Escape-Html $downloadName)' aria-label='Baixar captura original em tamanho completo'><img src='$imageUri' alt='$(Escape-Html $_.caption)'><span class='zoom'>Baixar original ↗</span></a><figcaption><strong>Estado real da interface</strong><p>$(Escape-Html $_.caption)</p></figcaption></figure>"
}) -join "`n"
if(!$screens.Count){$images="<div class='empty'><strong>Nenhuma captura revisada nesta rodada.</strong><br>As provas HTTP/PostgreSQL continuam nos cenários abaixo. Uma imagem ausente não foi tratada como teste visual aprovado.</div>"}
$limits=($result.limits|ForEach-Object {"<li>$(Escape-Html $_)</li>"}) -join ''
$templatePath=Join-Path $PSScriptRoot 'qa/template.html'
$html=[IO.File]::ReadAllText($templatePath,[Text.Encoding]::UTF8)
$values=@{
    PROJECT=(Escape-Html $Project);DATE=(Escape-Html ([DateTimeOffset]::Parse($result.generatedAt).ToString("dd/MM/yyyy · HH:mm 'UTC'")));
    VERDICT=$(if($result.passed){'Rodada aprovada'}else{'Rodada com falha'});VERDICT_CLASS=$(if($result.passed){''}else{'failed'});
    VERDICT_ICON=$(if($result.passed){'✓'}else{'!'});PASSED=$(if($null -eq $result.testsPassed){'—'}else{Escape-Html $result.testsPassed});
    TESTS=$(if($null -eq $result.tests){'—'}else{Escape-Html $result.tests});FAILS=$(if($null -eq $result.testsFailed){'não informadas'}else{Escape-Html $result.testsFailed});
    STEPS=(Escape-Html $result.stepsPassed);IMAGES=$screens.Count;CASES=$cases.Count;
    CASE_COUNTS=("$(@($cases|Where-Object {$_.result -eq 'passou'}).Count) passaram · $(@($cases|Where-Object {$_.result -eq 'nao-executado'}).Count) não executados");
    VOLUMES=$(if($result.volumeRemoved){'Remoção registrada'}else{'Preservados'});
    FAILURE=$(if($result.failureStage){"<p class='failure-note'><strong>Falha do fluxo:</strong> $(Escape-Html $result.failureStage). Resultados parciais permanecem disponíveis abaixo.</p>"}else{''});
    GALLERY=$images;SCENARIOS=$rows;LIMITS=$limits;JSON_URI=('data:application/json;base64,'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($result|ConvertTo-Json -Depth 7))))
}
# Replace only tokens in the trusted template; never reinterpret tokens inside user text.
$html=[regex]::Replace($html,'\{\{([A-Z_]+)\}\}',{param($match) [string]$values[$match.Groups[1].Value]})
[IO.File]::WriteAllText((Join-Path $directory 'qa.html'),$html,[Text.UTF8Encoding]::new($false))
Write-Output (Join-Path $directory 'qa.html')
