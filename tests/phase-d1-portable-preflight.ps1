param([int]$Port = 47837, [string]$HelperPath = '')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$published = if ($HelperPath) { (Resolve-Path -LiteralPath $HelperPath).Path } else { Join-Path $repo 'dist\SupermarketTrackerSync-1.0.0\SupermarketTrackerSync.exe' }
if (-not (Test-Path -LiteralPath $published)) { throw "Published helper not found: $published" }
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw "Port $Port is already in use" }
$runId = [guid]::NewGuid().ToString('N')
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $tempRoot "smtracker-phase-d1-portable-$runId"
$portableExe = Join-Path $testRoot 'SupermarketTrackerSync.exe'
$profile = Join-Path $testRoot 'chrome-profile'
$session = "phase-d1-portable-$runId"
$browserCli = Join-Path (Split-Path (Get-Command agent-browser).Source -Parent) 'node_modules\agent-browser\bin\agent-browser-win32-x64.exe'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$process = $null
$browserOpen = $false
$checks = [System.Collections.Generic.List[string]]::new()
function Check([bool]$Condition,[string]$Name) {
    if (-not $Condition) { throw "FAIL $Name" }
    $checks.Add($Name); Write-Host "PASS $Name"
}
function BrowserCall([string[]]$Action) {
    $output = & $browserCli --session $session --json @Action
    if ($LASTEXITCODE -ne 0) { throw "agent-browser failed: $output" }
    $result = $output | ConvertFrom-Json
    if (-not $result.success) { throw "Browser command failed: $($result.error)" }
    return $result.data
}
function Eval([string]$Code) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Code))
    return (BrowserCall @('eval','-b',$encoded)).result
}
try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    Copy-Item -LiteralPath $published -Destination $portableExe
    $files = @(Get-ChildItem -LiteralPath $testRoot -File)
    Check ($files.Count -eq 1 -and $files[0].Name -eq 'SupermarketTrackerSync.exe') 'Clean portable folder contains only the standalone executable'
    $process = Start-Process -FilePath $portableExe -ArgumentList @('--port',[string]$Port,'--no-open','--live-test') `
        -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru
    $status = $null
    for ($i=0; $i -lt 50; $i++) {
        try { $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -TimeoutSec 1; if ($status.connected) { break } } catch {}
        Start-Sleep -Milliseconds 250
    }
    Check ($status.connected -and $status.productCount -gt 0 -and $status.selectedSave -like 'slot_*.es3') 'Portable helper discovers and parses the actual save without a repository path'
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port | Select-Object -ExpandProperty LocalAddress -Unique)
    Check ($listeners.Count -eq 1 -and $listeners[0] -eq '127.0.0.1') 'Portable helper remains bound only to loopback'
    $html = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -TimeoutSec 5
    $script = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/src/game-sync.js" -TimeoutSec 5
    Check ($html.StatusCode -eq 200 -and $script.StatusCode -eq 200 -and
        $script.Content.Contains('TRACKER_VERSION') -and -not $html.Content.Contains($repo)) 'Portable executable serves embedded tracker assets without the original workspace path'
    $logPath = Join-Path $env:LOCALAPPDATA 'SupermarketTrackerSync\logs\helper.log'
    Check ((Test-Path -LiteralPath $logPath) -and -not (Test-Path -LiteralPath (Join-Path $testRoot 'logs'))) 'Runtime log is written under LocalAppData, not next to the EXE'

    & $browserCli --session $session --executable-path $chrome --profile $profile open "http://127.0.0.1:$Port/"
    if ($LASTEXITCODE -ne 0) { throw 'Could not launch isolated Chrome profile for portable preflight' }
    $browserOpen = $true
    BrowserCall @('wait','--fn',"window.GameSync?.getDiagnostics().state === 'connected'") | Out-Null
    $ui = (Eval @'
(() => {const d=GameSync.getDiagnostics();return JSON.stringify({mode:d.mode,state:d.state,
slot:d.status.selectedSave,products:d.status.productCount,
details:document.getElementById('gameSyncDetails').textContent,
onboarding:!!document.getElementById('gameSyncMigrationHint')});})()
'@) | ConvertFrom-Json
    Check ($ui.mode -eq 'review' -and $ui.state -eq 'connected' -and $ui.slot -eq $status.selectedSave -and
        $ui.products -eq $status.productCount -and $ui.details.Contains('1.0.0') -and
        $ui.details.Contains('sha256:') -and $ui.onboarding) 'Fresh portable tracker shows Connected, active save, Review mode, versions and migration hint'
    $errors = BrowserCall @('errors')
    Check ($errors.errors.Count -eq 0) 'Portable tracker has no uncaught browser JavaScript errors'
    New-Item -ItemType Directory -Path (Join-Path $repo 'docs\evidence') -Force | Out-Null
    BrowserCall @('screenshot',(Join-Path $repo 'docs\evidence\phase-d1-portable.png')) | Out-Null
    $result = @{ result='PASS'; checks=$checks; helperVersion=$status.helperVersion;
        selectedSave=$status.selectedSave; gameVersion=$status.gameVersion; productCount=$status.productCount;
        mappingDataVersion=$status.mappingDataVersion; listener=$listeners; browser=$ui;
        exeHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $portableExe).Hash }
    [IO.File]::WriteAllText((Join-Path $repo 'docs\evidence\phase-d1-portable.json'),
        ($result | ConvertTo-Json -Depth 8))
    Write-Output "RESULT portable preflight $($checks.Count) passed, 0 failed"
}
finally {
    if ($browserOpen) { try { BrowserCall @('close') | Out-Null } catch {} }
    if ($process) {
        $running = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction SilentlyContinue
        if ($running -and $running.ExecutablePath -eq [IO.Path]::GetFullPath($portableExe)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    if ($resolvedTestRoot.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedTestRoot) -eq "smtracker-phase-d1-portable-$runId" -and
        (Test-Path -LiteralPath $resolvedTestRoot)) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
