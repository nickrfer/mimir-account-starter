$ErrorActionPreference='Stop'
$root=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fixture=Join-Path $root ('.local/report-test-'+[guid]::NewGuid().ToString('N'))
$project='mimir-docker-0123456789'
foreach($part in @('tools/qa','docs/evidence',".local/$project/screenshots")){[void](New-Item -ItemType Directory -Path (Join-Path $fixture $part) -Force)}
Copy-Item -LiteralPath (Join-Path $root 'tools/qa-report.ps1') -Destination (Join-Path $fixture 'tools/qa-report.ps1')
Copy-Item -LiteralPath (Join-Path $root 'tools/qa/template.html') -Destination (Join-Path $fixture 'tools/qa/template.html')
$evidence=Join-Path $fixture "docs/evidence/docker-$project.json"
$directory=Join-Path $fixture ".local/$project"
$summary=@{project=$project;passed=$false;stepsPassed=6;failureStage='unit-and-postgresql';volumeRemoved=$false;completedStages=@('setup','container-build','clean-database','first-migration','second-migration')}
[IO.File]::WriteAllText($evidence,($summary|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $directory 'run.log'),"tests 7`npass 6`nfail 1`nTOKEN_NAO_DEVE_ENTRAR`n",[Text.UTF8Encoding]::new($false))
& (Join-Path $fixture 'tools/qa-report.ps1') -Project $project | Out-Null
$result=Get-Content -LiteralPath (Join-Path $directory 'qa.json') -Raw|ConvertFrom-Json
if($result.passed -or $result.testsFailed -ne 1 -or $result.scenarios[0].result -ne 'falhou' -or $result.scenarios[1].result -ne 'nao-executado'){throw 'Resultado inferido incorretamente'}
$summary.Remove('completedStages');$summary.passed=$true;$summary.failureStage=$null
[IO.File]::WriteAllText($evidence,($summary|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
& (Join-Path $fixture 'tools/qa-report.ps1') -Project $project | Out-Null
$result=Get-Content -LiteralPath (Join-Path $directory 'qa.json') -Raw|ConvertFrom-Json
if(@($result.scenarios|Where-Object {$_.result -ne 'nao-executado'}).Count){throw 'Rodada antiga ganhou cobertura presumida'}
[IO.File]::WriteAllBytes((Join-Path $directory 'screenshots/fixture.png'),[byte[]]@(0)) # Fixture do gerador, nao screenshot capturado/revisado.
$review=@(@{file='fixture.png';scenario='QA-UI-TEST';caption='<script>untrusted</script>';reviewed=$true;synthetic=$true})
[IO.File]::WriteAllText((Join-Path $directory 'screenshots/review.json'),(ConvertTo-Json -InputObject $review),[Text.UTF8Encoding]::new($false))
& (Join-Path $fixture 'tools/qa-report.ps1') -Project $project | Out-Null
$html=[IO.File]::ReadAllText((Join-Path $directory 'qa.html'))
if($html.Contains('<script>') -or !$html.Contains('&lt;script&gt;') -or $html.Contains('TOKEN_NAO_DEVE_ENTRAR')){throw 'HTML ou log nao sanitizado'}
if(!$html.Contains("src='data:image/png;base64,AA=='") -or $html.Contains("src='screenshots/fixture.png'")){throw 'Screenshot depende de arquivo externo no preview'}
if(!$html.Contains('img-src data:') -or !$html.Contains('href="data:application/json;base64,')){throw 'Relatorio nao e autocontido'}
$review[0].file='../outside.png'
[IO.File]::WriteAllText((Join-Path $directory 'screenshots/review.json'),(ConvertTo-Json -InputObject $review),[Text.UTF8Encoding]::new($false))
try{& (Join-Path $fixture 'tools/qa-report.ps1') -Project $project | Out-Null;throw 'Caminho inseguro aceito'}catch{if($_.Exception.Message -notmatch 'nome seguro'){throw}}
Write-Output 'PASS report: falha preservada, historico nao inferido, HTML escapado, log omitido e caminho recusado'
