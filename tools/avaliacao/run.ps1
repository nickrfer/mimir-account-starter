param(
    [Parameter(Mandatory)][ValidateSet('C01','C03','C04','C05')][string]$Scenario,
    [switch]$KeepRunning
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $root
$project = 'mimir-eval-' + $Scenario.ToLower() + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$config = ".local/$project"
$out = "$config/out"
[void](New-Item -ItemType Directory -Path $out -Force)
$env:MIMIR_CONFIG_DIR = $config
$commit = (git rev-parse HEAD).Trim()
$productChanged = [bool](git diff --name-only poc-v1.0.0 -- apps packages database Dockerfile compose.yaml)
$compose = @('compose', '--env-file', "$config/.env", '-p', $project, '-f', 'compose.yaml', '-f', 'compose.test.yaml', '--profile', 'tools')
function Invoke-Docker([string[]]$Arguments) {
    & docker @Arguments 2>&1 | Out-File -LiteralPath "$config/run.log" -Append -Encoding utf8
    if ($LASTEXITCODE) { throw "docker $($Arguments -join ' ') falhou; ver $config/run.log" }
}
Write-Output "Projeto $project ($Scenario), commit $commit, produto igual a poc-v1.0.0: $(-not $productChanged)"
Invoke-Docker @('compose', '-p', $project, '-f', 'compose.setup.yaml', 'run', '--rm', 'setup', "/workspace/$config", $config)
Invoke-Docker ($compose + @('up', '-d', '--wait', 'db'))
Invoke-Docker ($compose + @('build', 'admin'))
Invoke-Docker ($compose + @('run', '--rm', 'admin', 'migrate'))
$dockerVersion = (docker version --format '{{.Server.Version}}').Trim()
$mounts = @('-v', "${root}/tools/avaliacao:/app/tools/avaliacao:ro", '-v', "${root}/${out}:/out")
$envs = @('-e', "EVAL_SCENARIO=$Scenario", '-e', "EVAL_PROJECT=$project", '-e', "EVAL_COMMIT=$commit", '-e', "EVAL_PRODUCT_CHANGED=$productChanged", '-e', "EVAL_DOCKER=$dockerVersion")
$started = Get-Date
& docker @compose run --rm @mounts @envs --entrypoint node admin "tools/avaliacao/$($Scenario.ToLower()).mjs" 2>&1 | Tee-Object -FilePath "$config/scenario.log" | Select-String -Pattern '^(EVAL|CASE-FAIL|VERDICT|ERROR)'
$code = $LASTEXITCODE
Write-Output ("Duração: {0:N0} s; código {1}" -f ((Get-Date) - $started).TotalSeconds, $code)
if ($Scenario -eq 'C05') { Write-Output "Pacote do C05 em $out" } elseif (Test-Path "$out/result.json") {
    [void](New-Item -ItemType Directory -Path 'docs/avaliacao/resultados' -Force)
    Copy-Item "$out/result.json" "docs/avaliacao/resultados/$Scenario.json" -Force
    if (Test-Path "$out/result.md") { Copy-Item "$out/result.md" "docs/avaliacao/resultados/$Scenario.md" -Force }
    Write-Output "Resultado: docs/avaliacao/resultados/$Scenario.json"
}
if (-not $KeepRunning) { Invoke-Docker ($compose + @('down')) }
exit $code
