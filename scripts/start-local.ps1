param([switch]$Bootstrap, [string]$LoraCheckpoint)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$workspaceRoot = $projectRoot
$pythonPath = if ($env:PASSIVE_BCI_PYTHON) { $env:PASSIVE_BCI_PYTHON } else { Join-Path $projectRoot '.venv\Scripts\python.exe' }
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Local Python environment is missing; run scripts/setup-backend.ps1.' }
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    $nodeFolder = Get-ChildItem (Join-Path $workspaceRoot '.tools') -Directory -Filter 'node-*-win-x64' | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $nodeFolder) { throw 'Install Node.js or place a portable Node in .tools.' }
    $env:Path = $nodeFolder.FullName + ';' + $env:Path
}
$env:PASSIVE_BCI_PYTHON = $pythonPath
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
    $optional = $false
    if (-not $LoraCheckpoint) {
        $adapterRoot = if ($env:REVE_ADAPTER_ROOT) { $env:REVE_ADAPTER_ROOT } else { Join-Path $projectRoot 'checkpoints/adapters' }
        $LoraCheckpoint = Join-Path $adapterRoot 'stieger2021_4class_reve_lora_r16_mi5init/best.pt'
        $optional = $true
    }
    if (Test-Path -LiteralPath $LoraCheckpoint -PathType Leaf) {
        $env:MODEL_REVE_LORA = (Resolve-Path -LiteralPath $LoraCheckpoint).Path
        $env:MODEL_REVE_NO_LORA = '0'
        $env:MODEL_REVE_FRESH_HEAD = '0'
        $env:MODEL_REVE_CHECKPOINT_HEAD = '1'
        Write-Output 'New subjects use the selected LoRA encoder and its full embedded linear head as initialization. Tongue imagery still needs subject-specific training.'
    } elseif ($optional) {
        Write-Output 'No default LoRA checkpoint found; the model panel selects encoder and head per task.'
    } else {
        throw 'Selected LoRA checkpoint is missing. Supply -LoraCheckpoint or use -Bootstrap for an untrained head.'
    }
}
Push-Location $projectRoot
try { & npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort }
finally { Pop-Location }
