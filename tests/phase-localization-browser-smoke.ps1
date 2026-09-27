param(
    [ValidateSet('chrome','edge')][string]$Browser = 'chrome',
    [int]$Port = 47840,
    [int]$HelperPort = 47839,
    [int]$CDPPort = 0,
    [ValidatePattern('^[a-z0-9-]+$')][string]$EvidencePrefix = 'localization'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$outerRoot = Split-Path $repo -Parent
$runId = [guid]::NewGuid().ToString('N').Substring(0,8)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $tempRoot "smtracker-localization-$runId"
$profile = Join-Path $testRoot "$Browser-profile"
$downloads = Join-Path $testRoot 'downloads'
$helperLog = Join-Path $testRoot 'helper.log'
$helperError = Join-Path $testRoot 'helper-error.log'
$fixtureLog = Join-Path $testRoot 'fixture.log'
$fixtureError = Join-Path $testRoot 'fixture-error.log'
$session = "localization-$Browser-$runId"
$helperUrl = "http://127.0.0.1:$HelperPort"
$fixtureUrl = "http://127.0.0.1:$Port"
$savePath = Join-Path $env:USERPROFILE 'AppData\LocalLow\Nokta Games\Supermarket Simulator\slot_0.es3'
$saveHashBefore = if (Test-Path -LiteralPath $savePath) { (Get-FileHash -Algorithm SHA256 -LiteralPath $savePath).Hash } else { $null }
$browserCli = Join-Path (Split-Path (Get-Command agent-browser).Source -Parent) 'node_modules\agent-browser\bin\agent-browser-win32-x64.exe'
$executable = if ($Browser -eq 'chrome') { 'C:\Program Files\Google\Chrome\Application\chrome.exe' } else { 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }
$dotnet = (Get-Command dotnet).Source
$helperDll = Join-Path $repo 'src\SupermarketTrackerSync\bin\Release\net8.0\SupermarketTrackerSync.dll'
$checks = [System.Collections.Generic.List[string]]::new()
$helperProcess = $null
$fixtureProcess = $null
$sessionOpened = $false
$oldFixtureHelperUrl = $env:SMTRACKER_HELPER_URL
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $repo 'docs\evidence') -Force | Out-Null

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
function Check([bool]$Condition,[string]$Name) {
    if (-not $Condition) { throw "FAIL $Browser $Name" }
    $checks.Add($Name); Write-Host "PASS $Browser $Name"
}
function Wait-Ready([string]$Url,[string]$What) {
    for ($i=0; $i -lt 80; $i++) {
        try { $r=Invoke-RestMethod -Uri $Url -TimeoutSec 1; if ($r) { return } } catch {}
        Start-Sleep -Milliseconds 250
    }
    throw "$What did not start: $Url"
}
function Wait-Downloaded([string]$Pattern) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $item = Get-ChildItem -LiteralPath $downloads -Filter $Pattern -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($item) { return $item.FullName }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Download did not complete: $Pattern"
}

try {
    if (-not (Test-Path -LiteralPath $helperDll)) { throw "Build the helper before browser tests: $helperDll" }
    $helperProcess = Start-Process -FilePath $dotnet -ArgumentList @($helperDll,'--no-open','--port',[string]$HelperPort) `
        -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput $helperLog -RedirectStandardError $helperError
    Wait-Ready "$helperUrl/health" 'Read-only helper'
    $env:SMTRACKER_HELPER_URL = $helperUrl
    $fixtureProcess = Start-Process -FilePath (Get-Command node).Source `
        -ArgumentList @((Join-Path $repo 'tests\autosync-fixture-server.js'), [string]$Port) `
        -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput $fixtureLog -RedirectStandardError $fixtureError
    Wait-Ready "$fixtureUrl/health" 'In-memory browser fixture'

    if ($CDPPort -gt 0) {
        & $browserCli --session $session --cdp $CDPPort --download-path $downloads open "$fixtureUrl/"
    } else {
        & $browserCli --session $session --executable-path $executable --profile $profile --download-path $downloads open "$fixtureUrl/"
    }
    if ($LASTEXITCODE -ne 0) { throw "Could not launch isolated $Browser session" }
    $sessionOpened = $true
    BrowserCall @('wait','--fn',"window.GameSync?.getDiagnostics().state === 'connected' && window.TrackerLocalization?.getAvailableLocales().includes('ru-RU')") | Out-Null
    Check ((Eval 'document.getElementById("displayLanguage")?.value === "en"') -eq $true) 'Display language starts in English by default'

    $seed = Eval @'
(() => {const saved=JSON.parse(localStorage.getItem('smtracker_v6'));
const p=saved.products.find(item=>item.name==='Cereal - Chokipik');
if(!p)throw new Error('canonical ProductID 33 tracker row is missing');
p.productId=33;localStorage.setItem('smtracker_v6',JSON.stringify(saved));location.reload();return 'seeded';})()
'@
    BrowserCall @('wait','--fn',"window.GameSync?.getDiagnostics().state === 'connected' && state.products.some(p=>p.productId===33)") | Out-Null
    BrowserCall @('wait','--fn',"window.TrackerLocalization?.getAvailableLocales().includes('ru-RU')") | Out-Null
    Eval "switchTab('products');" | Out-Null
    BrowserCall @('select','#displayLanguage','ru-RU') | Out-Null
    BrowserCall @('wait','--fn',"window.TrackerLocalization?.getProduct({productId:33})?.localizedLabel === 'Хлопья' && getProductDisplayName(state.products.find(p=>p.productId===33)) === 'Хлопья - Chokipik'") | Out-Null
    Check ((Eval 'window.TrackerLocalization.getLocale()==="ru-RU" && localStorage.getItem("smtracker_displayLocale")==="ru-RU"') -eq $true) 'Russian language selection persists in its own preference key'
    Check ((Eval 'getProductDisplayName(state.products.find(p=>p.productId===33)) === "Хлопья - Chokipik"') -eq $true) 'ProductID 33 uses the official Russian label and the ProductSO brand'
    Check ((Eval 'getProductDisplayCategory(state.products.find(p=>p.productId===33)) === "Хлопья"') -eq $true) 'Product category uses the official Russian table value'
    Check ((Eval 'Array.from(document.querySelectorAll("#productsPanel th")).some(th=>th.textContent.includes("Средняя себестоимость / шт."))') -eq $true) 'Average Cost table label uses the existing Russian localization layer'

    $before = (Eval 'JSON.stringify({products:state.products,history:state.priceHistory,canonical:state.products.find(p=>p.productId===33).name})') | ConvertFrom-Json
    Eval "document.getElementById('searchInput').value='Хлопья';filterProducts();" | Out-Null
    Check ((Eval 'getDisplayProducts().some(p=>p.productId===33) && getDisplayProducts().length===1') -eq $true) 'Cyrillic search alias finds ProductID 33'
    Eval "document.getElementById('searchInput').value='Cereal - Chokipik';filterProducts();" | Out-Null
    Check ((Eval 'getDisplayProducts().some(p=>p.productId===33)') -eq $true) 'Canonical English product name remains searchable in Russian mode'
    Eval "document.getElementById('searchInput').value='Chokipik';filterProducts();" | Out-Null
    Check ((Eval 'getDisplayProducts().some(p=>p.productId===33)') -eq $true) 'Canonical inline brand remains searchable'
    Eval "document.getElementById('searchInput').value='33';filterProducts();" | Out-Null
    Check ((Eval 'getDisplayProducts().some(p=>p.productId===33)') -eq $true) 'ProductID remains a search alias'

    Eval "document.getElementById('searchInput').value='';document.getElementById('categoryFilter').value='Cereal';filterProducts();" | Out-Null
    $category = (Eval 'JSON.stringify({value:document.getElementById("categoryFilter").value,label:Array.from(document.getElementById("categoryFilter").options).find(o=>o.value==="Cereal")?.text,count:getDisplayProducts().length,has33:getDisplayProducts().some(p=>p.productId===33)})') | ConvertFrom-Json
    Check ($category.value -eq 'Cereal' -and $category.label -eq 'Хлопья' -and $category.has33) 'Category filter displays Russian while retaining the canonical category value'
    $row = Eval '(() => {const row=Array.from(document.querySelectorAll("#productsPanel tbody tr")).find(r=>r.cells[0].title.includes("ProductID: 33"));return row?JSON.stringify({label:row.cells[0].innerText,title:row.cells[0].title,brand:row.cells[1].innerText}):"{}";})()' | ConvertFrom-Json
    Check ($row.label.StartsWith('Хлопья') -and $row.brand -eq 'Chokipik' -and $row.title -like '*Cereal - Chokipik*ProductID: 33*') 'Product table shows localized label with canonical ProductID identity available in its tooltip'

    BrowserCall @('select','#displayLanguage','en') | Out-Null
    BrowserCall @('wait','--fn',"getProductDisplayName(state.products.find(p=>p.productId===33)) === 'Cereal - Chokipik'") | Out-Null
    BrowserCall @('select','#displayLanguage','ru-RU') | Out-Null
    BrowserCall @('wait','--fn',"getProductDisplayName(state.products.find(p=>p.productId===33)) === 'Хлопья - Chokipik'") | Out-Null
    $after = (Eval 'JSON.stringify({products:state.products,history:state.priceHistory,canonical:state.products.find(p=>p.productId===33).name})') | ConvertFrom-Json
    Check ($before.canonical -eq $after.canonical -and (ConvertTo-Json $before.products -Compress -Depth 20) -eq (ConvertTo-Json $after.products -Compress -Depth 20) `
        -and (ConvertTo-Json $before.history -Compress -Depth 20) -eq (ConvertTo-Json $after.history -Compress -Depth 20)) 'Language toggles preserve canonical names, ProductID, prices, and complete price history'

    Eval "document.getElementById('searchInput').value='';document.getElementById('categoryFilter').value='';filterProducts();" | Out-Null
    Eval 'window.__backupCapture=null;URL.createObjectURL=blob=>{blob.text().then(text=>window.__backupCapture=text);return "blob:tracker-test";};URL.revokeObjectURL=()=>{};HTMLAnchorElement.prototype.click=function(){};' | Out-Null
    BrowserCall @('click',"button[onclick='exportFullBackup()']") | Out-Null
    BrowserCall @('wait','--fn','window.__backupCapture !== null') | Out-Null
    $backup = Eval 'JSON.stringify({displayLocale:JSON.parse(window.__backupCapture).displayLocale,productCount:JSON.parse(window.__backupCapture).state.products.length})' | ConvertFrom-Json
    Check ($backup.displayLocale -eq 'ru-RU' -and $backup.productCount -gt 250) 'Full backup exports the display locale without replacing tracker state'

    BrowserCall @('reload') | Out-Null
    BrowserCall @('wait','--load','domcontentloaded') | Out-Null
    $reloadProbe = Eval 'JSON.stringify({url:location.href,title:document.title,locale:window.TrackerLocalization?.getLocale(),stored:localStorage.getItem("smtracker_displayLocale"),label:window.TrackerLocalization?.getProduct({productId:33})?.localizedLabel,productCount:typeof state==="undefined"?null:state.products.length,errors:window.__browserErrors})'
    Write-Host "Reload probe $Browser $reloadProbe"
    if ((($reloadProbe | ConvertFrom-Json).label) -ne 'Хлопья') {
        BrowserCall @('wait','--fn',"window.TrackerLocalization?.getProduct({productId:33})?.localizedLabel === 'Хлопья'") | Out-Null
    }
    Check ((Eval 'document.getElementById("displayLanguage").value==="ru-RU" && getProductDisplayName(state.products.find(p=>p.productId===33))==="Хлопья - Chokipik"') -eq $true) 'Russian label and selector survive reload'
    Check (((BrowserCall @('errors')).errors.Count -eq 0)) 'No uncaught browser JavaScript errors'

    $saveHashAfter = if (Test-Path -LiteralPath $savePath) { (Get-FileHash -Algorithm SHA256 -LiteralPath $savePath).Hash } else { $null }
    Check ($saveHashBefore -eq $saveHashAfter) 'Actual game save SHA-256 is unchanged during browser localization checks'
    BrowserCall @('screenshot',(Join-Path $repo "docs\evidence\$EvidencePrefix-$Browser.png")) | Out-Null
    $result = @{browser=$Browser;session=$session;checks=$checks;saveHashBefore=$saveHashBefore;saveHashAfter=$saveHashAfter;result='PASS'}
    [IO.File]::WriteAllText((Join-Path $repo "docs\evidence\$EvidencePrefix-$Browser.json"),($result | ConvertTo-Json -Depth 12))
    Write-Output "RESULT $Browser $($checks.Count) passed, 0 failed"
}
finally {
    $env:SMTRACKER_HELPER_URL = $oldFixtureHelperUrl
    if ($sessionOpened) { try { BrowserCall @('close') | Out-Null } catch {} }
    foreach ($process in @($fixtureProcess,$helperProcess)) {
        if ($process -and -not $process.HasExited) {
            try { Stop-Process -Id $process.Id -Force } catch {}
        }
    }
    $fullTestRoot=[IO.Path]::GetFullPath($testRoot)
    if ($fullTestRoot.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($fullTestRoot) -eq "smtracker-localization-$runId" -and (Test-Path -LiteralPath $fullTestRoot)) {
        Remove-Item -LiteralPath $fullTestRoot -Recurse -Force
    }
}
