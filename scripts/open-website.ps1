param([switch]$NoBrowser, [switch]$NoModel, [string]$BaseUrl = 'http://127.0.0.1:5173')
$ErrorActionPreference = 'Stop'
$siteUrl = $BaseUrl.TrimEnd('/') + '/'
$projectRoot = Split-Path $PSScriptRoot -Parent
$workspaceRoot = Split-Path $projectRoot -Parent
$logRoot = Join-Path $workspaceRoot '.tools'
function Test-SiteReady {
    try {
        $response = Invoke-WebRequest -Uri $siteUrl -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch { return $false }
}
try {
    if (-not (Test-SiteReady)) {
        Write-Host 'Starting Passive BCI website...'
        $startScript = Join-Path $PSScriptRoot 'start-local.ps1'
        $null = New-Item -ItemType Directory -Path $logRoot -Force
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $startScript + '"'
        $siteProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot 'website.stdout.log') -RedirectStandardError (Join-Path $logRoot 'website.stderr.log') -PassThru
        $ready = $false
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            if (Test-SiteReady) { $ready = $true; break }
            if ($siteProcess.HasExited) { break }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) {
            Get-Content (Join-Path $logRoot 'website.stderr.log') -Tail 15 -ErrorAction SilentlyContinue
            throw "Website failed to start. See logs in: $logRoot"
        }
    }

    # The UI must remain reachable even when a recording blocks model startup.
    if (-not $NoBrowser) { Start-Process $siteUrl }
    Write-Host 'Website ready. Close local services with Close Passive BCI or scripts/stop-local.ps1.'
    if ($NoModel) { return }
    $recordState = Invoke-RestMethod -Uri ($siteUrl + 'api/record/active') -TimeoutSec 10
    if ($recordState.id) {
        Write-Host "Recording active: $($recordState.rel). Opened the website without replacing the model."
        Write-Host 'Use Stop in the acquisition page to save normally; stop-local.ps1 also preserves received data when closing.'
        return
    }
    $statusUrl = $siteUrl + 'api/model-service/status'
    $modelStatus = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 10
    if ($modelStatus.starting) {
        Write-Host 'Waiting for the model already loading...'
        $deadline = (Get-Date).AddSeconds(190)
        while ($modelStatus.starting -and (Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2
            $modelStatus = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 10
        }
        if ($modelStatus.starting) { throw 'Model is still loading. Check the model panel before trying again.' }
        if (-not $modelStatus.running) { throw "Model startup failed: $($modelStatus.message)" }
    }
    if (-not $modelStatus.running) {
        Write-Host 'Loading REVE / SMR model on GPU (first startup may take up to 3 minutes)...'
        $modelStatus = Invoke-RestMethod -Method Post -Uri ($siteUrl + 'api/model-service/ensure') -ContentType 'application/json' -Body '{"backend":"reve","task":"smr_control"}' -TimeoutSec 210
        if (-not $modelStatus.ok -or -not $modelStatus.running) {
            throw "Model startup failed: $($modelStatus.message)"
        }
    }
    Write-Host "Website and model are ready. Model: $($modelStatus.backend) / $($modelStatus.task), port $($modelStatus.port)."
} catch {
    $failureMessage = $_.Exception.Message
    if ($_.ErrorDetails.Message) {
        try {
            $apiError = $_.ErrorDetails.Message | ConvertFrom-Json
            if ($apiError.message) { $failureMessage = $apiError.message }
        } catch { }
    }
    Write-Host ('Startup failed: ' + $failureMessage) -ForegroundColor Red
    Write-Host "Logs: $logRoot\website.stdout.log"
    Write-Host 'If the website is ready, it remains available even when model loading fails.'
    Write-Host 'To close local services, run scripts/stop-local.ps1.'
    exit 1
}
