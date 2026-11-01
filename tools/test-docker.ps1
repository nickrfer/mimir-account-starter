param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$project = 'mimir-docker-' + [guid]::NewGuid().ToString('N').Substring(0, 10)
$config = '.local/' + $project
[void](New-Item -ItemType Directory -Path $config -Force)
$log = Join-Path $root ($config + '/run.log')
$previousConfig = $env:MIMIR_CONFIG_DIR
$env:MIMIR_CONFIG_DIR = $config
$script:composeArgs = @('compose', '-p', $project, '-f', 'compose.setup.yaml')
$script:stage = 'setup'
$script:steps = 0
$passed = $false
$failureStage = $null
$composeReady = $false
$script:completedStages = @()
function Save-Progress {
    param([string]$Status)
    $state = @{schemaVersion=1; project=$project; stage=$script:stage; status=$Status; stepsPassed=$script:steps; totalSteps=22; completedStages=$script:completedStages; updatedAt=[DateTime]::UtcNow.ToString('o')}
    [IO.File]::WriteAllText((Join-Path $root "$config/progress.json"),($state | ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
}

function Invoke-Step {
    param([string]$Name, [string[]]$Command, [int]$ExpectedExit = 0)
    $script:stage = $Name
    Save-Progress 'running'
    Write-Output "START $Name ($($script:steps)/22 etapas concluidas)"
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & docker @script:composeArgs @Command 2>&1
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    $output | Out-File -LiteralPath $log -Append -Encoding utf8
    if ($code -ne $ExpectedExit) { throw "Stage $Name failed (exit $code)" }
    $script:lastOutput = $output -join "`n"
    $script:steps++
    $script:completedStages += $Name
    Save-Progress 'running'
    Write-Output "PASS $Name"
}

try {
    Invoke-Step 'setup' @('run', '--rm', 'setup', "/workspace/$config", $config)
    $script:composeArgs = @('compose', '--env-file', "$config/.env", '-p', $project, '-f', 'compose.yaml', '-f', 'compose.test.yaml', '--profile', 'tools')
    $composeReady = $true
    Invoke-Step 'container-build' @('--profile', 'dev', 'build', 'api', 'admin', 'verifier', 'dev-web')
    Invoke-Step 'clean-database' @('up', '-d', '--wait', 'db')
    Invoke-Step 'first-migration' @('run', '--rm', 'admin', 'migrate')
    if (!$script:lastOutput.Contains('001_core.sql')) { throw 'First migration was not applied' }
    Invoke-Step 'second-migration' @('run', '--rm', 'admin', 'migrate')
    if (!$script:lastOutput.Contains('"migrationsApplied":[]')) { throw 'Second migration was not empty' }
    Invoke-Step 'unit-and-postgresql' @('run', '--rm', '--entrypoint', 'node', 'admin', 'tools/checks/tests.mjs', 'all')
    Invoke-Step 'api-start' @('up', '-d', 'api')
    Invoke-Step 'http-spa-ready' @('run', '--rm', '--no-deps', '--entrypoint', 'node', 'admin', 'tools/checks/probe.mjs', 'available')
    Invoke-Step 'api-environment' @('exec', '-T', 'api', 'node', 'tools/runtime/audit.mjs')
    Invoke-Step 'session-create-real-api' @('run', '--rm', '--no-deps', '--entrypoint', 'node', 'admin', 'tools/checks/auth-probe.mjs', 'create')
    Invoke-Step 'database-stop' @('stop', 'db')
    Invoke-Step 'unavailable' @('run', '--rm', '--no-deps', '--entrypoint', 'node', 'admin', 'tools/checks/probe.mjs', 'unavailable')
    Invoke-Step 'session-database-error-sanitized' @('run', '--rm', '--no-deps', '--entrypoint', 'node', 'admin', 'tools/checks/auth-probe.mjs', 'outage')
    Invoke-Step 'database-recreate' @('up', '-d', '--wait', '--force-recreate', 'db')
    Invoke-Step 'api-recreate' @('up', '-d', '--force-recreate', 'api')
    Invoke-Step 'recovered' @('run', '--rm', '--no-deps', '--entrypoint', 'node', 'admin', 'tools/checks/probe.mjs', 'available')
    Invoke-Step 'session-persisted-after-recreate' @('run', '--rm', '--no-deps', '--entrypoint', 'node', 'admin', 'tools/checks/auth-probe.mjs', 'resume')
    Invoke-Step 'volume-preserved' @('run', '--rm', '--no-deps', '--entrypoint', 'node', 'admin', 'tools/checks/probe.mjs', 'persisted')
    Invoke-Step 'vite-start' @('--profile', 'dev', 'up', '-d', 'dev-web')
    $uid = if ($env:LOCAL_UID) { $env:LOCAL_UID } else { '1000' }
    $gid = if ($env:LOCAL_GID) { $env:LOCAL_GID } else { '1000' }
    Invoke-Step 'vite-proxy-hmr' @('run', '--rm', '--no-deps', '--user', "${uid}:${gid}", '-v', "${root}/apps/web/src:/hmr", '--entrypoint', 'node', 'admin', 'tools/checks/probe.mjs', 'dev')
    Invoke-Step 'verifier-not-implemented' @('run', '--rm', '--no-deps', 'verifier') 2
    $passed = $true
} catch {
    $failureStage = $script:stage
    Write-Output "FAIL $script:stage. Log local: $config/run.log"
} finally {
    if ($composeReady) {
        try { Invoke-Step 'stop-owned-project' @('--profile', 'dev', 'down') }
        catch { $passed = $false; $failureStage = 'stop-owned-project'; Write-Output 'FAIL stop-owned-project' }
    }
    $env:MIMIR_CONFIG_DIR = $previousConfig
    Save-Progress $(if($passed){'passed'}else{'failed'})
    $evidence = "docs/evidence/docker-$project.json"
    $json = @{project=$project; passed=$passed; stepsPassed=$script:steps; lastStage=$script:stage; failureStage=$failureStage; volumeRemoved=$false; runner='PowerShell'; completedStages=$script:completedStages} | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText((Join-Path $root $evidence), $json + "`n", [System.Text.UTF8Encoding]::new($false))
    Write-Output "Evidencia: $evidence"
}
if (!$passed) { exit 1 }
