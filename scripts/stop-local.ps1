<# Close the local workspace, retaining received recording data. Never kill by image name. #>
[CmdletBinding()]
param([string]$BaseUrl = '', [switch]$ServicesOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))

function Read-ApiError($failure) {
    if ($failure.ErrorDetails.Message) {
        try { return ($failure.ErrorDetails.Message | ConvertFrom-Json).message } catch { }
    }
    return $failure.Exception.Message
}
function Invoke-LocalPost([string]$base, [string]$route) {
    $result = Invoke-RestMethod -Method Post -Uri ($base + $route) -ContentType 'application/json' -Body '{}' -TimeoutSec 30
    if (-not $result.ok) { throw $result.message }
    return $result
}

# Every 5173-5179 loopback listener owned by this project's vite.js.
function Get-WorkspaceSites {
    $sites = @()
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -ge 5173 -and $_.LocalPort -le 5179 })
    foreach ($listener in $listeners) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if (-not $proc -or -not $proc.CommandLine) { continue }
        if ($proc.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        if ($proc.CommandLine -notmatch 'vite[\\/]bin[\\/]vite\.js') { continue }
        $sites += [pscustomobject]@{ Base = "http://127.0.0.1:$($listener.LocalPort)"; Process = $proc }
    }
    return $sites
}

try {
    $sites = @()
    if ($BaseUrl) {
        $base = $BaseUrl.TrimEnd('/')
        $uri = [Uri]$base
        if (-not $uri.IsLoopback -or $uri.Scheme -ne 'http') { throw 'Only a local HTTP workspace can be closed.' }
        if ($ServicesOnly) {
            $sites += [pscustomobject]@{ Base = $base; Process = $null }
        } else {
            $listener = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $uri.Port })
            if (-not $listener.Count) { Write-Host 'Passive BCI is already closed.'; return }
            $owners = @($listener | Select-Object -ExpandProperty OwningProcess -Unique)
            if ($owners.Count -ne 1) { throw 'Multiple processes own the website port; no process was stopped.' }
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($owners[0])"
            if (-not $proc -or -not $proc.CommandLine -or $proc.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
                $proc.CommandLine -notmatch 'vite[\\/]bin[\\/]vite\.js') {
                throw 'The website port is not owned by this project Vite process; no process was stopped.'
            }
            $sites += [pscustomobject]@{ Base = $base; Process = $proc }
        }
    } else {
        $sites = @(Get-WorkspaceSites)
        if (-not $sites.Count) { Write-Host 'Passive BCI is already closed.'; return }
    }

    foreach ($site in $sites) {
        # Stop owned producers first, then retain all bytes the website received.
        $null = Invoke-LocalPost $site.Base '/api/model-service/stop'
        foreach ($bridge in @('omni', 'omni-sdk', 'bcigo', 'neuracle')) {
            $null = Invoke-LocalPost $site.Base ("/api/bridge/$bridge/stop")
        }
        for ($attempt = 0; $attempt -lt 16; $attempt++) {
            $active = Invoke-RestMethod -Uri ($site.Base + '/api/record/active') -TimeoutSec 10
            if (-not $active.id) { break }
            if ($active.id -notmatch '^[a-zA-Z0-9_-]{8,64}$') { throw 'Invalid recording identifier; website left running.' }
            # A closed browser cannot flush remaining buffers/clock. Mark interrupted.
            $finishFailure = $null
            try {
                $null = Invoke-RestMethod -Method Post -Uri ($site.Base + '/api/record/' + $active.id + '/finish') -ContentType 'application/json' -Body '{"incomplete":true}' -TimeoutSec 30
            } catch {
                if (-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 409) { throw }
                $finishFailure = $_
            }
            $after = Invoke-RestMethod -Uri ($site.Base + '/api/record/active') -TimeoutSec 10
            if ($after.id -eq $active.id) {
                if ($finishFailure) { throw (Read-ApiError $finishFailure) }
                throw 'Recording is still active; website left running to protect the data.'
            }
            Write-Host "Saved received data as interrupted: $($active.rel)"
        }
        $remaining = Invoke-RestMethod -Uri ($site.Base + '/api/record/active') -TimeoutSec 10
        if ($remaining.id) { throw 'Recordings are still active; website left running.' }

        if ($site.Process -and -not $ServicesOnly) {
            $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($site.Process.ProcessId)"
            if ($current) {
                if ($current.CreationDate -ne $site.Process.CreationDate -or $current.CommandLine -ne $site.Process.CommandLine) {
                    throw 'Website process identity changed; refused to stop the replacement process.'
                }
                & taskkill.exe /PID $site.Process.ProcessId /T /F | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Could not close the website process.' }
            }
            Write-Host "Closed Passive BCI at $($site.Base)." -ForegroundColor Green
        }
    }
    if ($ServicesOnly) {
        Write-Host 'Models, device bridges and recordings stopped. Website left running.' -ForegroundColor Green
    } else {
        Write-Host 'Passive BCI closed. Recordings have been retained.' -ForegroundColor Green
    }
} catch {
    Write-Host ('Close failed: ' + (Read-ApiError $_)) -ForegroundColor Red
    Write-Host 'The website was not forcibly terminated. Recording files have not been deleted.'
    exit 1
}
