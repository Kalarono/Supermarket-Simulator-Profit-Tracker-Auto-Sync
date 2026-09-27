param(
    [ValidatePattern('^[a-z0-9-]+$')][string]$EvidencePrefix = 'phase-d',
    [string]$HelperPath = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$helper = if ($HelperPath) { (Resolve-Path -LiteralPath $HelperPath).Path } else { Join-Path $repo 'dist\SupermarketTrackerSync-1.0.0\SupermarketTrackerSync.exe' }
$runId = [guid]::NewGuid().ToString('N')
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temp = Join-Path $tempRoot "smtracker-phase-d-helper-$runId"
$port = 47839
New-Item -ItemType Directory -Path $temp | Out-Null
$save = Join-Path $temp 'slot_0.es3'
$fixture = '{"Progression":{"value":{"GameVersion":"v-test","UnlockedLicenses":[1],"ActiveLicenses":[1]}},"Price":{"value":{"PricingDatas":[{"ProductID":33,"Price":1.5,"DiscountRate":0}],"PricesSetByPlayer":[{"ProductID":33,"Price":2.0}],"AverageCosts":[]}}}'
[IO.File]::WriteAllText($save,$fixture,[Text.UTF8Encoding]::new($false))
$saveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $save).Hash
$checks = [System.Collections.Generic.List[string]]::new()
$primary = $null
$secondary = $null
$http = [System.Net.Http.HttpClient]::new()
function Check([bool]$Condition,[string]$Name) {
    if (-not $Condition) { throw "FAIL $Name" }
    $checks.Add($Name); Write-Host "PASS $Name"
}
try {
    $primary = Start-Process -FilePath $helper -ArgumentList @('--save',"`"$save`"",'--port',[string]$port,'--no-open','--live-test') -WindowStyle Hidden -PassThru
    $ready = $false
    for ($i=0; $i -lt 40; $i++) {
        try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 1; if ($health.status -eq 'ok') { $ready=$true; break } } catch {}
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'Test helper did not become ready' }
    $status = $null
    for ($i=0; $i -lt 40; $i++) {
        try { $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/status" -TimeoutSec 1; if ($status.connected) { break } } catch {}
        Start-Sleep -Milliseconds 250
    }
    if (-not $status.connected) { throw "Isolated save did not parse: $($status.error)" }
    $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$port/snapshot"
    Check ($status.connected -and $status.productCount -eq 1 -and $snapshot.products[0].productId -eq 33) 'Read-only helper parses the isolated ES3 fixture and serves snapshot API'
    Check ($status.helperVersion -eq '1.0.0' -and $status.trackerVersion -eq '2.9' -and
        $status.schemaVersion -eq 3 -and $status.mappingDataVersion -match '^sha256:[a-f0-9]{12}$') 'API exposes helper, tracker, schema and mapping versions'
    $logPath = Join-Path $env:LOCALAPPDATA 'SupermarketTrackerSync\logs\helper.log'
    Check ((Test-Path -LiteralPath $logPath) -and
        (Get-Content -LiteralPath $logPath -Raw).Contains('Live test diagnostics enabled')) 'Live diagnostics use a LocalAppData log'
    $html = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -TimeoutSec 5
    $js = Invoke-WebRequest -Uri "http://127.0.0.1:$port/src/game-sync.js" -TimeoutSec 5
    Check ($html.StatusCode -eq 200 -and $html.Content.Contains('Game Sync') -and $js.Content.Contains('validateAutoSyncSnapshot')) 'Helper hosts tracker HTML and its matching adapter'
    $localizationClient = Invoke-WebRequest -Uri "http://127.0.0.1:$port/src/game-localization.js" -TimeoutSec 5
    $locales = Invoke-RestMethod -Uri "http://127.0.0.1:$port/locales" -TimeoutSec 5
    $russianResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$port/localization/ru-RU" -TimeoutSec 5
    $russian = $russianResponse.Content | ConvertFrom-Json -AsHashtable
    $localized33 = $russian.products['33']
    Check ($localizationClient.StatusCode -eq 200 -and $html.Content.Contains('displayLanguage') -and
        ($locales.available -contains 'ru-RU') -and $localized33.displayName -eq 'Хлопья - Chokipik') 'Published EXE embeds the localization client and serves official ProductID 33 Russian data'
    $listener = @(Get-NetTCPConnection -State Listen -LocalPort $port | Select-Object -ExpandProperty LocalAddress -Unique)
    Write-Host "Listener addresses: $($listener -join ', ')"
    Check (($listener.Count -eq 1) -and ($listener[0] -eq '127.0.0.1')) 'HTTP listener is bound only to IPv4 loopback'

    $methodResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -Method Post -SkipHttpErrorCheck
    Check ($methodResponse.StatusCode -eq 405) 'POST is rejected; helper exposes no write API'
    $originResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -Headers @{Origin='http://evil.invalid'} -SkipHttpErrorCheck
    Check ($originResponse.StatusCode -eq 403) 'Untrusted CORS origin is denied'
    $hostRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get,"http://127.0.0.1:$port/health")
    $hostRequest.Headers.Host = "localhost:$port"
    $hostResponse = $http.Send($hostRequest)
    Check ([int]$hostResponse.StatusCode -eq 403) 'Non-literal loopback Host is denied against DNS rebinding'
    $traversal = Invoke-WebRequest -Uri "http://127.0.0.1:$port/%2e%2e/Program.cs" -SkipHttpErrorCheck
    Check ($traversal.StatusCode -in @(400,404) -and -not $traversal.Content.Contains('WebApplication.CreateBuilder')) 'Path traversal resolves no filesystem content'

    $secondary = Start-Process -FilePath $helper -ArgumentList @('--save',"`"$save`"",'--port',[string]$port,'--no-open') -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
    $secondaryRefresh = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
    $secondaryAlive = Get-Process -Id $secondary.Id -ErrorAction SilentlyContinue
    Check ($secondaryRefresh.status -eq 'ok' -and -not $secondaryAlive -and (Get-Process -Id $primary.Id -ErrorAction SilentlyContinue)) 'Second launch exits cleanly and leaves the original helper serving'

    $inspect = Start-Process -FilePath $helper -ArgumentList @('--inspect','--save',"`"$save`"") -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $temp 'inspect.json') -RedirectStandardError (Join-Path $temp 'inspect-error.log')
    $inspection = Get-Content -LiteralPath (Join-Path $temp 'inspect.json') -Raw | ConvertFrom-Json
    Check ($inspect.ExitCode -eq 0 -and $inspection.readOnly -and $inspection.fields.marketPrices -eq 1) 'Inspect command succeeds in one-shot read-only mode'
    $localeInspect = Start-Process -FilePath $helper -ArgumentList '--inspect-localization' -WindowStyle Hidden -PassThru -Wait `
        -RedirectStandardOutput (Join-Path $temp 'localization-inspect.json') -RedirectStandardError (Join-Path $temp 'localization-inspect-error.log')
    $localeReport = Get-Content -LiteralPath (Join-Path $temp 'localization-inspect.json') -Raw | ConvertFrom-Json
    Check ($localeInspect.ExitCode -eq 0 -and $localeReport.readOnly -and $localeReport.localizedProductLabels -eq 292 -and
        $localeReport.samples.Count -ge 10) 'Published EXE localization inspector discovers game data and reports coverage/examples'
    $version = Start-Process -FilePath $helper -ArgumentList '--version' -WindowStyle Hidden -PassThru -Wait `
        -RedirectStandardOutput (Join-Path $temp 'version.txt') -RedirectStandardError (Join-Path $temp 'version-error.log')
    $versionText = Get-Content -LiteralPath (Join-Path $temp 'version.txt') -Raw
    Check ($version.ExitCode -eq 0 -and $versionText.Contains('SupermarketTrackerSync 1.0.0') -and
        $versionText.Contains('API schema 3') -and $versionText.Contains('mapping sha256:')) 'Published EXE --version reports build and mapping metadata'
    Check ((Get-FileHash -Algorithm SHA256 -LiteralPath $save).Hash -eq $saveHash) 'Helper startup, API, duplicate launch and inspect leave fixture save byte-identical'

    $result = @{result='PASS';checks=$checks;helper=$helper;pid=$primary.Id;listener=$listener;fixtureHashBefore=$saveHash;
        fixtureHashAfter=(Get-FileHash -Algorithm SHA256 -LiteralPath $save).Hash;status=$status}
    New-Item -ItemType Directory -Path (Join-Path $repo 'docs\evidence') -Force | Out-Null
    $evidence = Join-Path $repo "docs\evidence\$EvidencePrefix-helper-lifecycle.json"
    [IO.File]::WriteAllText($evidence,($result | ConvertTo-Json -Depth 10))
    Write-Output "RESULT helper lifecycle $($checks.Count) passed, 0 failed"
}
finally {
    $http.Dispose()
    foreach ($candidate in @($secondary,$primary)) {
        if ($candidate) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.Id)" -ErrorAction SilentlyContinue
            if ($proc -and $proc.ExecutablePath -eq [IO.Path]::GetFullPath($helper)) { Stop-Process -Id $candidate.Id -Force -ErrorAction SilentlyContinue }
        }
    }
    $fullTemp=[IO.Path]::GetFullPath($temp)
    if ($fullTemp.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($fullTemp) -eq "smtracker-phase-d-helper-$runId" -and (Test-Path -LiteralPath $fullTemp)) {
        Remove-Item -LiteralPath $fullTemp -Recurse -Force
    }
}
