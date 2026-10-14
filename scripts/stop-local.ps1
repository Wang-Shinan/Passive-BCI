<# Close the local workspace, retaining received recording data. Never kill by image name. #>
[CmdletBinding()]
param([string]$BaseUrl = 'http://127.0.0.1:5173', [switch]$ServicesOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$base = $BaseUrl.TrimEnd('/')
$uri = [Uri]$base
if (-not $uri.IsLoopback -or $uri.Scheme -ne 'http') { throw 'Only a local HTTP workspace can be closed.' }

function Read-ApiError($failure) {
    if ($failure.ErrorDetails.Message) {
        try { return ($failure.ErrorDetails.Message | ConvertFrom-Json).message } catch { }
    }
    return $failure.Exception.Message
}
function Invoke-LocalPost([string]$route) {
    $result = Invoke-RestMethod -Method Post -Uri ($base + $route) -ContentType 'application/json' -Body '{}' -TimeoutSec 30
    if (-not $result.ok) { throw $result.message }
    return $result
}

try {
    $siteOwner = $null
    if (-not $ServicesOnly) {
        $listener = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $uri.Port })
        if (-not $listener.Count) { Write-Host 'Passive BCI is already closed.'; return }
        $owners = @($listener | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($owners.Count -ne 1) { throw 'Multiple processes own the website port; no process was stopped.' }
        $siteOwner = Get-CimInstance Win32_Process -Filter "ProcessId = $($owners[0])"
        if (-not $siteOwner -or -not $siteOwner.CommandLine -or $siteOwner.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
            $siteOwner.CommandLine -notmatch 'vite[\\/]bin[\\/]vite\.js') {
            throw 'The website port is not owned by this project Vite process; no process was stopped.'
        }
    }

    # Stop owned producers first, then retain all bytes the website received.
    $null = Invoke-LocalPost '/api/model-service/stop'
    foreach ($bridge in @('omni', 'omni-sdk', 'bcigo', 'neuracle')) {
        $null = Invoke-LocalPost ("/api/bridge/$bridge/stop")
    }
    for ($attempt = 0; $attempt -lt 16; $attempt++) {
        $active = Invoke-RestMethod -Uri ($base + '/api/record/active') -TimeoutSec 10
        if (-not $active.id) { break }
        if ($active.id -notmatch '^[a-zA-Z0-9_-]{8,64}$') { throw 'Invalid recording identifier; website left running.' }
        # A closed browser cannot flush remaining buffers/clock. Mark interrupted.
        $finishFailure = $null
        try {
            $null = Invoke-RestMethod -Method Post -Uri ($base + '/api/record/' + $active.id + '/finish') -ContentType 'application/json' -Body '{"incomplete":true}' -TimeoutSec 30
        } catch {
            if (-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 409) { throw }
            $finishFailure = $_
        }
        $after = Invoke-RestMethod -Uri ($base + '/api/record/active') -TimeoutSec 10
        if ($after.id -eq $active.id) {
            if ($finishFailure) { throw (Read-ApiError $finishFailure) }
            throw 'Recording is still active; website left running to protect the data.'
        }
        Write-Host "Saved received data as interrupted: $($active.rel)"
    }
    $remaining = Invoke-RestMethod -Uri ($base + '/api/record/active') -TimeoutSec 10
    if ($remaining.id) { throw 'Recordings are still active; website left running.' }

    if ($siteOwner) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($siteOwner.ProcessId)"
        if ($current) {
            if ($current.CreationDate -ne $siteOwner.CreationDate -or $current.CommandLine -ne $siteOwner.CommandLine) {
                throw 'Website process identity changed; refused to stop the replacement process.'
            }
            & taskkill.exe /PID $siteOwner.ProcessId /T /F | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Could not close the website process.' }
        }
        Write-Host 'Passive BCI closed. Recordings have been retained.' -ForegroundColor Green
    } else {
        Write-Host 'Models, device bridges and recordings stopped. Website left running.' -ForegroundColor Green
    }
} catch {
    Write-Host ('Close failed: ' + (Read-ApiError $_)) -ForegroundColor Red
    Write-Host 'The website was not forcibly terminated. Recording files have not been deleted.'
    exit 1
}
