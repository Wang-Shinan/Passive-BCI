<#
Restart the web-managed SMR model. New subjects use the LoRA embedded head.
Examples (run from the Passive-BCI directory):
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-model-service.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-model-service.ps1 -HeadId smr_control_lp_example.pt
The website must already be running. Recording/training locks are enforced by its API.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$BaseUrl = 'http://127.0.0.1:5173',
    [string]$HeadId = '',
    [ValidateRange(0.05, 10)]
    [double]$StepSec = 0.1
)

$ErrorActionPreference = 'Stop'
$api = $BaseUrl.TrimEnd('/') + '/api/model-service'
try {
    try {
        $status = Invoke-RestMethod -Uri ($api + '/status') -TimeoutSec 10
    } catch {
        throw "Cannot reach the local website at $BaseUrl. Start scripts/start-local.ps1 first. $($_.Exception.Message)"
    }
    if ($status.starting) { throw 'The model is already loading. Wait for it to finish before restarting.' }
    if ($status.running -and -not $status.owned) {
        throw 'The model port is owned by an external process. Close that model terminal first, then run this script again.'
    }
    $headDescription = if ($HeadId) { $HeadId } else { 'LoRA embedded linear head (new subject)' }
    if (-not $PSCmdlet.ShouldProcess($BaseUrl, "Restart REVE / smr_control using $headDescription")) { return }

    Write-Host "Restarting REVE / SMR using $headDescription ..."
    Write-Host 'Model loading may take up to 3 minutes.'
    # A single ensure request checks the recording/training lock before stopping
    # the old process. Do not call /stop first, which could interrupt recording.
    $body = @{ backend = 'reve'; task = 'smr_control'; headId = $HeadId; stepSec = $StepSec; force = $true } | ConvertTo-Json -Compress
    $result = Invoke-RestMethod -Method Post -Uri ($api + '/ensure') -ContentType 'application/json' -Body $body -TimeoutSec 210
    if (-not $result.ok -or -not $result.running) { throw "Model restart failed: $($result.message)" }
    Write-Host "Ready: REVE / smr_control, port $($result.port), PID $($result.pid)." -ForegroundColor Green
    Write-Host 'If the page has not reconnected, use its model connection button or refresh the page.'
} catch {
    $failureMessage = $_.Exception.Message
    if ($_.ErrorDetails.Message) {
        try {
            $apiError = $_.ErrorDetails.Message | ConvertFrom-Json
            if ($apiError.message) { $failureMessage = $apiError.message }
        } catch { }
    }
    Write-Host ('Restart failed: ' + $failureMessage) -ForegroundColor Red
    exit 1
}
