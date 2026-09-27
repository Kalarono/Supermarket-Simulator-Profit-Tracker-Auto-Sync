param(
    [Parameter(Mandatory=$true)][int]$HelperProcessId,
    [ValidateSet('chrome','edge')][string[]]$Browsers = @('chrome','edge')
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$helperPath = Join-Path $repo 'dist\SupermarketTrackerSync-1.0.0\SupermarketTrackerSync.exe'
$process = Get-Process -Id $HelperProcessId
if ($process.Path -ne $helperPath) { throw 'Refusing to stop a process other than the published test helper' }
$browserCli = Join-Path (Split-Path (Get-Command agent-browser).Source -Parent) 'node_modules\agent-browser\bin\agent-browser-win32-x64.exe'
$reports = $Browsers | ForEach-Object {
    Get-Content (Join-Path $repo "docs\evidence\$_-result.json") -Raw | ConvertFrom-Json
}
$checks = [System.Collections.Generic.List[string]]::new()
function Call($session, [string[]]$Action) {
    $output = & $browserCli --session $session --json @Action
    if ($LASTEXITCODE -ne 0) { throw "Browser failed: $output" }
    $result = $output | ConvertFrom-Json
    if (-not $result.success) { throw $result.error }
    return $result.data
}
function Eval($session, $code) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($code))
    return (Call $session @('eval','-b',$encoded)).result
}
function Check($condition,$label) {
    if (-not $condition) { throw "FAIL $label" }
    $checks.Add($label); Write-Host "PASS $label"
}
foreach ($report in $reports) {
    Eval $report.session 'sessionStorage.setItem("__c5RestartBefore",localStorage.getItem("smtracker_v6"));' | Out-Null
}
Stop-Process -Id $HelperProcessId
try {
    foreach ($report in $reports) {
        Call $report.session @('click','#gameSyncRefreshBtn') | Out-Null
        Call $report.session @('wait','--fn',"GameSync.getDiagnostics().state === 'offline'") | Out-Null
        Check (Eval $report.session 'GameSync.getDiagnostics().state==="offline" && document.getElementById("gameSyncReviewBtn").disabled') "$($report.browser): stopped helper is unavailable and Apply access disabled"
        Check (Eval $report.session '(() => {const a=JSON.parse(localStorage.getItem("smtracker_v6"));const b=JSON.parse(sessionStorage.getItem("__c5RestartBefore"));return JSON.stringify(a.products)===JSON.stringify(b.products)&&JSON.stringify(a.priceHistory)===JSON.stringify(b.priceHistory);})()') "$($report.browser): offline tracker data unchanged"
    }
} finally {
    $restarted = Start-Process -FilePath $helperPath -ArgumentList '--no-open' -WindowStyle Hidden -PassThru
    Write-Host "Restarted helper PID $($restarted.Id)"
}
foreach ($report in $reports) {
    Call $report.session @('click','#gameSyncRefreshBtn') | Out-Null
    Call $report.session @('wait','--fn',"GameSync.getDiagnostics().state === 'connected'") | Out-Null
    Check (Eval $report.session 'GameSync.getDiagnostics().status.productCount===309 && GameSync.getDiagnostics().review.coverage.confirmed===292') "$($report.browser): reconnect restores 309 products and 292 mappings"
    Call $report.session @('reload') | Out-Null
    Call $report.session @('wait','--fn',"window.GameSync?.getDiagnostics().state === 'connected'") | Out-Null
    Check (Eval $report.session '(() => {const a=JSON.parse(localStorage.getItem("smtracker_v6"));const b=JSON.parse(sessionStorage.getItem("__c5RestartBefore"));return JSON.stringify(a.products)===JSON.stringify(b.products)&&JSON.stringify(a.priceHistory)===JSON.stringify(b.priceHistory)&&GameSync.getDiagnostics().mode==="review";})()') "$($report.browser): restart and reload preserve prices/history without automatic Apply"
}
$result = @{result='PASS';checks=$checks;helperProcessId=$restarted.Id}
[IO.File]::WriteAllText((Join-Path $repo 'docs\evidence\helper-restart.json'),($result | ConvertTo-Json -Depth 5))
Write-Host "RESULT $($checks.Count) passed, 0 failed"
