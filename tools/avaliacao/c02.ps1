param([int]$OutageSeconds = 5)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $root
$project = 'mimir-eval-c02-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$config = ".local/$project"; $out = "$config/out"; $signals = "$config/signals"
[void](New-Item -ItemType Directory -Path $out, $signals -Force)
$env:MIMIR_CONFIG_DIR = $config
$commit = (git rev-parse HEAD).Trim()
$productChanged = [bool](git diff --name-only poc-v1.0.0 -- apps packages database Dockerfile compose.yaml)
$compose = @('compose', '--env-file', "$config/.env", '-p', $project, '-f', 'compose.yaml', '-f', 'compose.test.yaml', '--profile', 'tools')
function Invoke-Docker([string[]]$Arguments) {
    & docker @Arguments 2>&1 | Out-File -LiteralPath "$config/run.log" -Append -Encoding utf8
    if ($LASTEXITCODE) { throw "docker $($Arguments -join ' ') falhou; ver $config/run.log" }
}
function Log([string]$Text) { $line = "{0:HH:mm:ss} {1}" -f (Get-Date), $Text; $line | Out-File -LiteralPath "$config/orchestrator.log" -Append -Encoding utf8 }
Write-Output "Projeto $project (C02), commit $commit, produto igual a poc-v1.0.0: $(-not $productChanged)"
Invoke-Docker @('compose', '-p', $project, '-f', 'compose.setup.yaml', 'run', '--rm', 'setup', "/workspace/$config", $config)
Invoke-Docker ($compose + @('up', '-d', '--wait', 'db'))
Invoke-Docker ($compose + @('build', 'admin'))
Invoke-Docker ($compose + @('run', '--rm', 'admin', 'migrate'))
$dockerVersion = (docker version --format '{{.Server.Version}}').Trim()
$mounts = @('-v', "${root}/tools/avaliacao:/app/tools/avaliacao:ro", '-v', "${root}/${out}:/out", '-v', "${root}/${signals}:/signals")
$envs = @('-e', 'EVAL_SCENARIO=C02', '-e', "EVAL_PROJECT=$project", '-e', "EVAL_COMMIT=$commit", '-e', "EVAL_PRODUCT_CHANGED=$productChanged", '-e', "EVAL_DOCKER=$dockerVersion")
$executorCount = 0
function Start-Executor {
    $script:executorCount++
    $name = "$project-executor-$($script:executorCount)"
    Invoke-Docker ($compose + @('run', '-d', '--name', $name) + $mounts + @('--entrypoint', 'node', 'admin', 'tools/avaliacao/c02/executor.mjs'))
    return $name
}
$executor = Start-Executor
$driver = "$project-driver"
Invoke-Docker ($compose + @('run', '-d', '--name', $driver) + $mounts + $envs + @('--entrypoint', 'node', 'admin', 'tools/avaliacao/c02/driver.mjs'))
Log "executor $executor, driver $driver"
$handled = @{}
while (-not (Test-Path "$signals/finished")) {
    $state = (docker inspect -f '{{.State.Running}}' $driver 2>$null)
    if ($state -ne 'true' -and -not (Test-Path "$signals/finished")) { Log 'driver encerrou sem sinal finished'; break }
    foreach ($file in Get-ChildItem $signals -Filter 'paused-*' -ErrorAction SilentlyContinue) {
        $index = $file.Name.Substring(7)
        if ($handled.ContainsKey($index)) { continue }
        $handled[$index] = $true
        $point = (Get-Content $file.FullName -Raw).Trim()
        if ($point -eq 'P5') {
            Log "run $index P5: SIGKILL em $executor"
            & docker kill --signal KILL $executor 2>&1 | Out-Null
            & docker rm -f $executor 2>&1 | Out-Null
            $executor = Start-Executor
            Log "run $index P5: novo executor $executor"
        } else {
            if ($point -eq 'P1') { for ($w = 0; $w -lt 300 -and -not (Test-Path "$signals/captured-$index"); $w++) { Start-Sleep -Milliseconds 100 } }
            Log "run $index ${point}: parando banco"
            Invoke-Docker ($compose + @('stop', 'db'))
            Set-Content "$signals/resume-$index" 'go'
            Start-Sleep -Seconds $OutageSeconds
            Invoke-Docker ($compose + @('up', '-d', '--wait', 'db'))
            Log "run $index ${point}: banco restaurado"
        }
        Set-Content "$signals/restored-$index" 'ok'
        Write-Output ("{0:HH:mm:ss} run {1} {2}: falha injetada e restaurada" -f (Get-Date), $index, $point)
    }
    Start-Sleep -Milliseconds 200
}
& docker logs $driver 2>&1 | Tee-Object -FilePath "$config/scenario.log" | Select-String -Pattern '^(EVAL|CASE-FAIL|VERDICT|ERROR)'
& docker rm -f $driver $executor 2>&1 | Out-Null
if (Test-Path "$out/result.json") {
    Copy-Item "$out/result.json" 'docs/avaliacao/resultados/C02.json' -Force
    Copy-Item "$out/result.md" 'docs/avaliacao/resultados/C02.md' -Force
    Write-Output 'Resultado: docs/avaliacao/resultados/C02.json'
}
Invoke-Docker ($compose + @('down'))
