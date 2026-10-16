param([int]$Port = 8769, [string]$Device = 'auto', [double]$StepSec = 0.1)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$nccRoot = Join-Path (Split-Path $projectRoot -Parent) 'NCC-OI-BCI'
$pythonPath = Join-Path $nccRoot '.venv/Scripts/python.exe'
$manifest = Join-Path $projectRoot 'recordings/.reve-dual-axis/s04_binary_4s.json'
if (-not (Test-Path -LiteralPath $manifest)) { throw 'Run scripts/import-s04-dual-axis.py after downloading both S04 checkpoints.' }
$env:PYTHONUTF8 = '1'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
& $pythonPath (Join-Path $nccRoot 'scripts/serve_reve_model.py') --task smr_dual_axis --state-file $manifest --device $Device --step-sec $StepSec --port $Port --host 127.0.0.1 --no-tcp
exit $LASTEXITCODE
