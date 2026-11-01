param(
    [Parameter(Position=0)][ValidateSet('status','subir','testar','evidencias','parar')][string]$Action='status',
    [ValidatePattern('^mimir-e2e-[a-f0-9]{10}$')][string]$LabId,
    [ValidatePattern('^[A-Za-z0-9_.-]{1,80}$')][string]$Owner,
    [ValidatePattern('^mimir-docker-[a-f0-9]{10}$')][string]$Project
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if($Action -eq 'testar'){
    $runLog=Join-Path $root ('.local/e2e-invoke-'+[guid]::NewGuid().ToString('N')+'.log')
    $shell=(Get-Process -Id $PID).Path
    & $shell -NoProfile -File (Join-Path $PSScriptRoot 'test-docker.ps1') 2>&1 | Tee-Object -FilePath $runLog
    $code=$LASTEXITCODE
    $line=Select-String -LiteralPath $runLog -Pattern 'Evidencia: docs/evidence/docker-(mimir-docker-[a-f0-9]{10})\.json' | Select-Object -Last 1
    if($line){& (Join-Path $PSScriptRoot 'qa-report.ps1') -Project $line.Matches[0].Groups[1].Value}
    exit $code
}
if($Action -eq 'evidencias'){
    if(!$Project){throw 'Informe -Project da rodada, sem escolher uma antiga implicitamente'}
    & (Join-Path $PSScriptRoot 'qa-report.ps1') -Project $Project
    exit
}
$labsRoot=Join-Path $root '.local/labs'
if(!$LabId -and $Action -eq 'status'){
    $labs=@(Get-ChildItem -LiteralPath $labsRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $path=Join-Path $_.FullName 'lab.json';if(Test-Path -LiteralPath $path){Get-Content -LiteralPath $path -Raw|ConvertFrom-Json}
    })
    ConvertTo-Json -InputObject $labs -Depth 4
    exit
}
if(!$LabId){
    if($Action -ne 'subir'){throw 'Informe -LabId; nunca selecionar laboratorio alheio implicitamente'}
    $LabId='mimir-e2e-'+[guid]::NewGuid().ToString('N').Substring(0,10)
}
if($Action -ne 'status' -and !$Owner){throw 'Informe -Owner desta sessao para subir/parar; use um identificador proprio estavel'}
$directory=Join-Path $labsRoot $LabId
$metadata=Join-Path $directory 'lab.json'
if($Action -ne 'subir' -and !(Test-Path -LiteralPath $metadata)){throw 'Laboratorio desconhecido; referencia local nao sera utilizada'}
if($Action -eq 'subir'){[void](New-Item -ItemType Directory -Path $directory -Force)}
$lock=$null
if($Action -ne 'status'){
    try{$lock=[IO.File]::Open((Join-Path $directory 'operation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
    catch{throw 'Outra operacao esta em andamento neste laboratorio; aguarde sem forcar'}
}
$priorConfig=$env:MIMIR_CONFIG_DIR
try{
    $state=if(Test-Path -LiteralPath $metadata){Get-Content -LiteralPath $metadata -Raw|ConvertFrom-Json}else{[pscustomobject]@{schemaVersion=1;labId=$LabId;owner=$Owner;status='created';url=$null;dataOrigin='synthetic';volumeRemoved=$false;updatedAt=[DateTime]::UtcNow.ToString('o')}}
    if($state.labId -ne $LabId){throw 'Identidade do laboratorio divergente'}
    if($Action -ne 'status' -and $state.owner -ne $Owner){throw "Laboratorio em uso por $($state.owner); nao assumir ou liberar automaticamente"}
    $config=".local/labs/$LabId"
    $env:MIMIR_CONFIG_DIR=$config
    $envPath=Join-Path $directory '.env'
    $logPath=Join-Path $directory 'operations.log'
    function Save-State {
        $state.updatedAt=[DateTime]::UtcNow.ToString('o')
        [IO.File]::WriteAllText($metadata,($state|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    }
    function Docker([string[]]$Arguments){
        $previous=$ErrorActionPreference;$ErrorActionPreference='Continue'
        try{$output=& docker @Arguments 2>&1;$code=$LASTEXITCODE}
        finally{$ErrorActionPreference=$previous}
        $output|Out-File -LiteralPath $logPath -Append -Encoding utf8
        if($code -ne 0){throw 'Docker falhou; diagnostico local em operations.log (revisar antes de compartilhar)'}
        return ($output -join "`n")
    }
    $compose=@('compose','--env-file',"$config/.env",'-p',$LabId,'-f','compose.yaml','-f','compose.test.yaml','--profile','tools')
    $override=Join-Path $directory 'lab.compose.yaml'
    if(Test-Path -LiteralPath $override){$compose+=@('-f',"$config/lab.compose.yaml")}
    switch($Action){
        'subir'{
            $state.status='starting';Save-State
            if(!(Test-Path -LiteralPath $envPath)){
                [void](Docker @('compose','-p',$LabId,'-f','compose.setup.yaml','run','--rm','setup',"/workspace/$config",$config))
            }
            [void](Docker ($compose+@('build','api','admin')))
            [void](Docker ($compose+@('up','-d','--wait','db')))
            [void](Docker ($compose+@('run','--rm','admin','migrate')))
            [void](Docker ($compose+@('up','-d','api')))
            $address=(Docker ($compose+@('port','api','3000'))).Trim()
            if($address -notmatch '^127\.0\.0\.1:\d+$'){throw 'Publicacao HTTP inesperada; verificar Compose'}
            $state.url="http://$address"
            # Pin the allocated loopback port across recreation; authorize only this local origin.
            [IO.File]::WriteAllText($override,"services:`n  api:`n    ports: !override ['$address`:3000']`n",[Text.UTF8Encoding]::new($false))
            if($compose -notcontains "$config/lab.compose.yaml"){$compose+=@('-f',"$config/lab.compose.yaml")}
            [IO.File]::AppendAllText($envPath,"`nMIMIR_ALLOWED_ORIGINS=$($state.url)`n",[Text.UTF8Encoding]::new($false))
            [void](Docker ($compose+@('up','-d','--force-recreate','api')))
            [void](Docker ($compose+@('run','--rm','--no-deps','--entrypoint','node','admin','tools/checks/probe.mjs','available')))
            [void](Docker ($compose+@('exec','-T','api','node','tools/runtime/audit.mjs')))
            $state.status='running';Save-State
        }
        'parar'{[void](Docker ($compose+@('--profile','dev','down')));$state.status='stopped';$state.url=$null;Save-State}
        'status'{
            # Metadata is not health proof: filtered live inventory is separate.
            $services=Docker ($compose+@('ps','--format','{{.Service}} {{.State}} {{.Health}} {{.Ports}}'))
            $state|Add-Member -NotePropertyName services -NotePropertyValue $services -Force
        }
    }
    $state|ConvertTo-Json -Depth 4
}finally{$env:MIMIR_CONFIG_DIR=$priorConfig;if($lock){$lock.Dispose()}}
