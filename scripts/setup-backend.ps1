# Explicit installer. Run only when ready to download the Python dependencies.
param([ValidateSet('cuda', 'cpu')][string]$Device = 'cuda')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$pythonPath = Join-Path $projectRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    & py -3.11 -m venv (Join-Path $projectRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 venv creation failed.' }
}
$index = if ($Device -eq 'cuda') { 'https://download.pytorch.org/whl/cu128' } else { 'https://download.pytorch.org/whl/cpu' }
& $pythonPath -m pip install 'torch==2.7.1' --index-url $index
if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed.' }
& $pythonPath -m pip install -r (Join-Path $projectRoot 'requirements-backend.txt')
if ($LASTEXITCODE -ne 0) { throw 'Backend dependency installation failed.' }
$env:PASSIVE_BCI_PYTHON = $pythonPath
Push-Location $projectRoot
try { & node scripts/backend-doctor.mjs }
finally { Pop-Location }
exit $LASTEXITCODE
