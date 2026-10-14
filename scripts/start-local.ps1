param([switch]$Bootstrap, [string]$LoraCheckpoint)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$workspaceRoot = Split-Path $projectRoot -Parent
$nccRoot = Join-Path $workspaceRoot 'NCC-OI-BCI'
$pythonPath = Join-Path $nccRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'NCC Python environment is missing; see NCC requirements-reve-windows.txt.' }
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    $nodeFolder = Get-ChildItem (Join-Path $workspaceRoot '.tools') -Directory -Filter 'node-*-win-x64' | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $nodeFolder) { throw 'Install Node.js or place a portable Node in .tools.' }
    $env:Path = $nodeFolder.FullName + ';' + $env:Path
}
$env:NCC_OI_BCI_ROOT = $nccRoot
$env:NCC_PYTHON = $pythonPath
$env:MODEL_DEVICE = 'cuda'
$env:MODEL_NO_TCP = '1'
$env:PYTHONUTF8 = '1'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
if ($Bootstrap) {
    $env:MODEL_REVE_NO_LORA = '1'
    $env:MODEL_REVE_FRESH_HEAD = '1'
    $env:MODEL_REVE_CHECKPOINT_HEAD = '0'
    Write-Warning 'Bootstrap: real REVE encoder, untrained classification head. This checks the pipeline, not brain-control accuracy.'
} else {
    if (-not $LoraCheckpoint) {
        $LoraCheckpoint = Join-Path $nccRoot 'checkpoints\adapters\stieger2021_4class_reve_lora_r16_mi5init\best.pt'
    }
    if (-not (Test-Path -LiteralPath $LoraCheckpoint -PathType Leaf)) { throw 'Selected LoRA checkpoint is missing. Supply -LoraCheckpoint or use -Bootstrap for an untrained head.' }
    $env:MODEL_REVE_LORA = (Resolve-Path -LiteralPath $LoraCheckpoint).Path
    $env:MODEL_REVE_NO_LORA = '0'
    $env:MODEL_REVE_FRESH_HEAD = '0'
    $env:MODEL_REVE_CHECKPOINT_HEAD = '1'
    Write-Output 'New subjects use the selected LoRA encoder and its full embedded linear head as initialization. Tongue imagery still needs subject-specific training.'
}
Push-Location $projectRoot
try { & npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort }
finally { Pop-Location }
