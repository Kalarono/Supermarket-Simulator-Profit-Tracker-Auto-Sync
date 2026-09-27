param(
    [string]$SourceSave = (Join-Path $env:USERPROFILE 'AppData\LocalLow\Nokta Games\Supermarket Simulator\slot_0.es3'),
    [int]$Port = 47838,
    [string]$HelperPath = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$helper = if ($HelperPath) { (Resolve-Path -LiteralPath $HelperPath).Path } else { Join-Path $repo 'dist\SupermarketTrackerSync-1.0.0\SupermarketTrackerSync.exe' }
$source = (Resolve-Path -LiteralPath $SourceSave).Path
if (-not $source.EndsWith('.es3',[StringComparison]::OrdinalIgnoreCase)) { throw 'Control source must be an .es3 save' }
if (-not (Test-Path -LiteralPath $helper)) { throw "Published helper not found: $helper" }
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw "Port $Port is already in use" }
$runId = [guid]::NewGuid().ToString('N')
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $tempRoot "smtracker-phase-d1-control-$runId"
$copy = Join-Path $testRoot 'slot_control.es3'
$process = $null
$checks = [System.Collections.Generic.List[string]]::new()
function Check([bool]$Condition,[string]$Name) {
    if (-not $Condition) { throw "FAIL $Name" }
    $checks.Add($Name); Write-Host "PASS $Name"
}
try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    $sourceHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
    Copy-Item -LiteralPath $source -Destination $copy
    $copyHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $copy).Hash
    $sourceHashAfterCopy = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
    Check ($sourceHashBefore -eq $sourceHashAfterCopy -and $sourceHashBefore -eq $copyHashBefore) 'Stable source copied byte-identically for read-only control'

    $process = Start-Process -FilePath $helper -ArgumentList @('--save',"`"$copy`"",'--port',[string]$Port,'--no-open','--live-test') -WindowStyle Hidden -PassThru
    $status = $null
    for ($i=0; $i -lt 50; $i++) {
        try { $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -TimeoutSec 1; if ($status.connected) { break } } catch {}
        Start-Sleep -Milliseconds 250
    }
    Check ($status.connected -and $status.selectedSave -eq 'slot_control.es3' -and $status.productCount -gt 0) 'Published helper parsed the control copy with read-only access'
    $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/snapshot" -TimeoutSec 5
    Check ($snapshot.snapshotHash -eq $status.snapshotHash -and $snapshot.products.Count -eq $status.productCount) 'API served one consistent control snapshot'
    $firstId = "$($status.selectedSave)|$($status.lastSaveWriteTime)|$($status.snapshotHash)"
    $same = $true
    for ($i=0; $i -lt 3; $i++) {
        Start-Sleep -Seconds 2
        $polled = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -TimeoutSec 5
        if (-not $polled.connected -or "$($polled.selectedSave)|$($polled.lastSaveWriteTime)|$($polled.snapshotHash)" -ne $firstId) { $same = $false }
    }
    Check $same 'Polling retained the same stable snapshot identity'
    $copyHashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $copy).Hash
    $sourceHashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
    Check ($copyHashBefore -eq $copyHashAfter -and $sourceHashBefore -eq $sourceHashAfter) 'Control copy and original save remain byte-identical after helper parse and polling'
    $evidence = @{ result='PASS'; checks=$checks; sourceSave=[IO.Path]::GetFileName($source);
        sourceHashBefore=$sourceHashBefore; sourceHashAfter=$sourceHashAfter;
        controlHashBefore=$copyHashBefore; controlHashAfter=$copyHashAfter;
        snapshotId=$firstId; gameVersion=$status.gameVersion; productCount=$status.productCount;
        helperVersion=$status.helperVersion }
    New-Item -ItemType Directory -Path (Join-Path $repo 'docs\evidence') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $repo 'docs\evidence\phase-d1-readonly-control.json'),
        ($evidence | ConvertTo-Json -Depth 8))
    Write-Output "RESULT read-only control $($checks.Count) passed, 0 failed"
}
finally {
    if ($process) {
        $running = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction SilentlyContinue
        if ($running -and $running.ExecutablePath -eq [IO.Path]::GetFullPath($helper)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    if ($resolvedTestRoot.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedTestRoot) -eq "smtracker-phase-d1-control-$runId" -and
        (Test-Path -LiteralPath $resolvedTestRoot)) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
