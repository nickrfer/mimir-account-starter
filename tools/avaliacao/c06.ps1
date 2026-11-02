$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $root
$project = 'mimir-eval-c06-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$config = ".local/$project"; $out = "$config/out"; $signals = "$config/signals"
[void](New-Item -ItemType Directory -Path $out, $signals -Force)
$env:MIMIR_CONFIG_DIR = $config
$env:MIMIR_HTTP_PORT = '0'
$commit = (git rev-parse HEAD).Trim()
$productChanged = [bool](git diff --name-only poc-v1.0.0 -- apps packages database Dockerfile compose.yaml)
$compose = @('compose', '--env-file', "$config/.env", '-p', $project, '-f', 'compose.yaml', '-f', 'compose.test.yaml', '-f', 'tools/avaliacao/c06.compose.yaml', '--profile', 'tools')
function Invoke-Docker([string[]]$Arguments) {
    & docker @Arguments 2>&1 | Out-File -LiteralPath "$config/run.log" -Append -Encoding utf8
    if ($LASTEXITCODE) { throw "docker $($Arguments -join ' ') falhou; ver $config/run.log" }
}
function Get-ApiHwm {
    $script = 'for d in /proc/[0-9]*; do case "$(tr "\000" " " < $d/cmdline 2>/dev/null)" in "node "*dist/index.js*) grep VmHWM $d/status;; esac; done'
    $line = (& docker compose --env-file "$config/.env" -p $project -f compose.yaml -f compose.test.yaml -f tools/avaliacao/c06.compose.yaml exec -T api sh -c $script) | Select-Object -First 1
    if ("$line" -match 'VmHWM:\s+(\d+)\s+kB') { return [int64]$Matches[1] * 1024 }
    throw "VmHWM não encontrado: $line"
}Write-Output "Projeto $project (C06), commit $commit, produto igual a poc-v1.0.0: $(-not $productChanged)"
Invoke-Docker @('compose', '-p', $project, '-f', 'compose.setup.yaml', 'run', '--rm', 'setup', "/workspace/$config", $config)
Invoke-Docker ($compose + @('up', '-d', '--wait', 'db'))
Invoke-Docker ($compose + @('build', 'admin', 'api'))
Invoke-Docker ($compose + @('run', '--rm', 'admin', 'migrate'))
Invoke-Docker ($compose + @('up', '-d', '--wait', 'api'))
$dockerVersion = (docker version --format '{{.Server.Version}}').Trim()
$mounts = @('-v', "${root}/tools/avaliacao:/app/tools/avaliacao:ro", '-v', "${root}/${out}:/out", '-v', "${root}/${signals}:/signals")
$envs = @('-e', 'EVAL_SCENARIO=C06', '-e', "EVAL_PROJECT=$project", '-e', "EVAL_COMMIT=$commit", '-e', "EVAL_PRODUCT_CHANGED=$productChanged", '-e', "EVAL_DOCKER=$dockerVersion")
$harness = "$project-harness"
Invoke-Docker ($compose + @('run', '-d', '--name', $harness) + $mounts + $envs + @('--entrypoint', 'node', 'admin', 'tools/avaliacao/c06.mjs'))
while ((docker inspect -f '{{.State.Running}}' $harness 2>$null) -eq 'true') {
    foreach ($request in Get-ChildItem $signals -Filter '*.request' -ErrorAction SilentlyContinue) {
        $name = $request.BaseName
        Remove-Item $request.FullName
        if ($name -eq 'restart-api') {
            Invoke-Docker ($compose + @('restart', 'api'))
            Invoke-Docker ($compose + @('up', '-d', '--wait', 'api'))
            Set-Content "$signals/$name.done" ("api reiniciada {0:o}" -f (Get-Date))
        } elseif ($name -eq 'read-hwm') {
            Set-Content "$signals/$name.done" (Get-ApiHwm)
        }
        Write-Output ("{0:HH:mm:ss} {1}" -f (Get-Date), $name)
    }
    Start-Sleep -Milliseconds 200
}
& docker logs $harness 2>&1 | Tee-Object -FilePath "$config/scenario.log" | Select-String -Pattern '^(EVAL|CASE-FAIL|VERDICT|ERROR)'
& docker rm -f $harness 2>&1 | Out-Null
if (Test-Path "$out/result.json") {
    Copy-Item "$out/result.json" 'docs/avaliacao/resultados/C06.json' -Force
    Copy-Item "$out/result.md" 'docs/avaliacao/resultados/C06.md' -Force
    Write-Output 'Resultado: docs/avaliacao/resultados/C06.json'
}
Invoke-Docker ($compose + @('down'))
