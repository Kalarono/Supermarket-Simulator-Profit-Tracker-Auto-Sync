param([ValidateSet('chrome','edge')][string]$Browser = 'chrome', [int]$Port = 47831, [int]$CDPPort = 0)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$runId = [guid]::NewGuid().ToString('N').Substring(0,8)
$testStarted = Get-Date
$session = "c5-$Browser-$runId"
$browserProfile = Join-Path (Split-Path $repo -Parent) "browser-c5-$Browser-$runId"
$downloadDir = Join-Path $browserProfile 'downloads'
New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
$browserCli = Join-Path (Split-Path (Get-Command agent-browser).Source -Parent) 'node_modules\agent-browser\bin\agent-browser-win32-x64.exe'
$evidence = Join-Path $repo 'docs\evidence'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$executable = if ($Browser -eq 'chrome') { 'C:\Program Files\Google\Chrome\Application\chrome.exe' } else { 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }
$checks = [System.Collections.Generic.List[string]]::new()
function BrowserCall([string[]]$Action) {
    Write-Host "Browser $Browser : $($Action[0])"
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
    $checks.Add($Name); Write-Output "PASS $Browser $Name"
}
function Wait-Downloaded([string]$Pattern) {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        $item = Get-ChildItem -LiteralPath $downloadDir -Filter $Pattern -File | Select-Object -First 1
        if (-not $item -and $CDPPort -gt 0) {
            $external = Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE 'Downloads') -Filter $Pattern -File -ErrorAction SilentlyContinue |
                Where-Object LastWriteTime -ge $testStarted | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($external) {
                Move-Item -LiteralPath $external.FullName -Destination (Join-Path $downloadDir $external.Name)
                $item = Get-Item -LiteralPath (Join-Path $downloadDir $external.Name)
            }
        }
        if ($item) { return $item.FullName }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Download did not complete: $Pattern"
}
if ($CDPPort -gt 0) {
    & $browserCli --session $session --cdp $CDPPort --download-path $downloadDir open "http://127.0.0.1:$Port/"
} else {
    & $browserCli --session $session --executable-path $executable --profile $browserProfile --download-path $downloadDir open "http://127.0.0.1:$Port/"
}
if ($LASTEXITCODE -ne 0) { throw 'Browser launch failed' }
BrowserCall @('wait','--fn',"window.GameSync?.getDiagnostics().state === 'connected'") | Out-Null
$initial = Eval @'
(() => { const d=GameSync.getDiagnostics(); sessionStorage.setItem('__c5Before',JSON.stringify(state));
sessionStorage.setItem('__c5Dashboard',document.getElementById('dashPanel').textContent);
return {browser:navigator.userAgent,products:d.status.productCount,slot:d.status.selectedSave,
confirmed:d.review.coverage.confirmed,changes:d.review.diffs.length,
averageCostChanges:d.review.diffs.filter(x=>x.field==='averageCost').length,
riceAverage:d.review.diffs.find(x=>x.key==='128:averageCost')?.to??null,
riceDiffKeys:d.review.diffs.filter(x=>x.productId===128).map(x=>x.key),
cerealDiffKeys:d.review.diffs.filter(x=>x.productId===33).map(x=>x.key),rows:state.products.length}; })()
'@
Check ($initial.products -eq 309 -and $initial.slot -eq 'slot_0.es3' -and $initial.confirmed -eq 292) 'Connected with real save and expanded mapping'
Check ($initial.changes -gt 0 -and $initial.averageCostChanges -gt 0 -and $initial.riceAverage -ne $null -and $initial.rows -eq 294) 'Fresh isolated tracker state includes separately sourced Average Cost changes'
$riceGame = (Invoke-RestMethod -Uri "http://127.0.0.1:$Port/snapshot" -TimeoutSec 5).products | Where-Object productId -eq 128
BrowserCall @('click','#gameSyncReviewBtn') | Out-Null
BrowserCall @('snapshot','-i','-s','#gameSyncReviewModal .game-sync-actions') | Out-Null
Check ((Eval 'document.querySelectorAll("#gameSyncReviewModal .game-sync-diff").length') -eq $initial.changes) 'Review modal lists applicable fields'
BrowserCall @('click','#gameSyncSelectNone') | Out-Null
$selectedKeys = @($initial.cerealDiffKeys) + @('165:supplierUnitPrice','165:onlineBuyPrice') + @($initial.riceDiffKeys)
$selectedKeysJson = ConvertTo-Json -InputObject $selectedKeys -Compress
Check ((Eval "(() => {const keys=$selectedKeysJson;for(const key of keys){const box=Array.from(document.querySelectorAll('#gameSyncReviewModal .game-sync-diff')).find(e=>e.dataset.key===key);if(!box)throw new Error('Missing Review field '+key);box.checked=true;}return keys.every(key=>Array.from(document.querySelectorAll('#gameSyncReviewModal .game-sync-diff')).some(e=>e.dataset.key===key&&e.checked));})()") -eq $true) 'Review selects the confirmed Rice fields and paired supplier/box prices'
BrowserCall @('click','#gameSyncApplyBtn') | Out-Null
BrowserCall @('wait','--fn',"!document.getElementById('gameSyncReviewModal').classList.contains('open')") | Out-Null
$applied = Eval @'
(() => { const before=JSON.parse(sessionStorage.getItem('__c5Before'));
const saved=JSON.parse(localStorage.getItem('smtracker_v6'));
const names=['Cereal - Chokipik','Apple'];
const values=names.map(name=>{const p=saved.products.find(p=>p.name===name);return {name,id:p.productId,market:p.marketPrice,sell:p.yourPrice,history:saved.priceHistory[name]};});
const rice=saved.products.find(p=>p.productId===128);
sessionStorage.setItem('__c5Expected',JSON.stringify(values));
return {values,rice:{averageCost:rice.averageCost,supplier:rice.supplierUnitPrice,box:rice.onlineBuyPrice,market:rice.marketPrice,sell:rice.yourPrice,history:saved.priceHistory[rice.name]},changed:GameSync.getDiagnostics().review.diffs.length,
pickupUnchanged:state.products.every((p,i)=>before.products[i].pickupBuyPrice==null || p.pickupBuyPrice===before.products[i].pickupBuyPrice),
dashboardChanged:document.getElementById('dashPanel').textContent!==sessionStorage.getItem('__c5Dashboard'),
backupExists:!!localStorage.getItem('smtracker_v6_before_gamesync_v1')};})()
'@
Check ($applied.values[0].id -eq 33 -and $applied.values[1].id -eq 165 -and $applied.rice.averageCost -eq $initial.riceAverage -and $applied.rice.supplier -eq $riceGame.supplierUnitPrice.value -and $applied.rice.box -eq $riceGame.supplierBoxPrice.value -and $applied.rice.market -eq $riceGame.marketPrice.value -and $applied.rice.sell -eq $riceGame.playerSellPrice.value -and $applied.changed -eq ($initial.changes - ($initial.cerealDiffKeys.Count + 2 + $initial.riceDiffKeys.Count))) 'Selective Apply syncs all five Rice price semantics and persists ProductIDs'
Eval "openDetail('Rice Basmati - Lustupacru');" | Out-Null
$culture = [Globalization.CultureInfo]::InvariantCulture
$sell = [double]$riceGame.playerSellPrice.value
$supplier = [double]$riceGame.supplierUnitPrice.value
$average = [double]$riceGame.averageCost.value
$market = [double]$riceGame.marketPrice.value
$quantity = [double]$riceGame.purchaseQuantity.value
$expectedDetail = @(
    'Average Cost / item',
    ('$' + $average.ToString('0.00',$culture)),
    ('$' + ($sell - $average).ToString('0.00',$culture)),
    ('$' + ($sell - $supplier).ToString('0.00',$culture)),
    ('$' + (($sell - $supplier) * $quantity).ToString('0.00',$culture)),
    ('+' + (($sell / $market - 1) * 100).ToString('0.0',$culture) + '%')
) | ConvertTo-Json -Compress
Check ((Eval "(() => {const t=document.getElementById('detailModal').textContent;return $expectedDetail.every(x=>t.includes(x));})()") -eq $true) 'Rice detail shows Average Cost, current inventory profit, new purchase profit and market deviation separately'
Eval 'document.getElementById("detailModal").classList.remove("open");' | Out-Null
Check ($applied.pickupUnchanged) 'Pickup purchase values remain unchanged by Game Sync'
Check ($applied.dashboardChanged) 'Dashboard recalculated'
Check ($applied.backupExists -and $applied.values[0].history[-1].source -eq 'game-review-sync' -and $applied.values[1].history[-1].source -eq 'game-review-sync' -and $applied.rice.history[-1].averageCost -eq $initial.riceAverage) 'Migration backup and shared history record Average Cost'
BrowserCall @('reload') | Out-Null
BrowserCall @('wait','--fn',"window.GameSync?.getDiagnostics().state === 'connected'") | Out-Null
$persisted = Eval @'
(() => {const expected=JSON.parse(sessionStorage.getItem('__c5Expected'));
return expected.every(e=>{const p=state.products.find(p=>p.name===e.name);return p.productId===e.id && p.marketPrice===e.market && p.yourPrice===e.sell && JSON.stringify(state.priceHistory[e.name])===JSON.stringify(e.history);});})()
'@
Check $persisted 'Reload keeps prices ProductIDs and history'
BrowserCall @('click',"button[onclick='exportFullBackup()']") | Out-Null
$backupPath = Wait-Downloaded 'supermarket-tracker-backup-*.json'
# Edge opens its downloads hub in a new tab; return to the observed tracker tab.
BrowserCall @('tab','t1') | Out-Null
$backup = Get-Content -LiteralPath $backupPath -Raw | ConvertFrom-Json
Check ($backup.schemaVersion -eq 2 -and ($backup.state.products | Where-Object productId -eq 33).yourPrice -eq $applied.values[0].sell -and $backup.state.priceHistory.'Cereal - Chokipik'[-1].source -eq 'game-review-sync') 'Downloaded full JSON backup contains applied data'
BrowserCall @('click','#gameSyncIssuesBtn') | Out-Null
BrowserCall @('snapshot','-i','-s','#gameSyncIssuesModal .game-sync-actions') | Out-Null
BrowserCall @('click','#gameSyncExportIssuesBtn') | Out-Null
$auditPath = Wait-Downloaded 'supermarket-tracker-mapping-audit.json'
BrowserCall @('tab','t1') | Out-Null
$audit = Get-Content -LiteralPath $auditPath -Raw | ConvertFrom-Json
Check ($audit.coverage.confirmed -eq 292 -and $audit.products.Count -eq 311 -and ($audit.products | Where-Object productId -eq 4).status -eq 'ambiguous') 'Mapping audit download and ambiguous exclusion'
BrowserCall @('click','#gameSyncCloseIssuesBtn') | Out-Null
BrowserCall @('select','#gameSyncMode','read-only') | Out-Null
BrowserCall @('click','#gameSyncReviewBtn') | Out-Null
Check (Eval 'document.getElementById("gameSyncApplyBtn").disabled') 'Read Only disables Apply'
BrowserCall @('click','#gameSyncCloseReviewBtn') | Out-Null
BrowserCall @('select','#gameSyncMode','review') | Out-Null
BrowserCall @('click','#gameSyncReviewBtn') | Out-Null
BrowserCall @('click','#gameSyncSelectNone') | Out-Null
$conflict = Eval '(() => {const d=GameSync.getDiagnostics().review.diffs.find(x=>x.field==="marketPrice");if(!d)throw new Error("No market price diff for stale review test");sessionStorage.setItem("__c5Conflict",JSON.stringify(d));return d.key;})()'
BrowserCall @('check',"input[data-key='$conflict']") | Out-Null
Eval '(() => {const d=JSON.parse(sessionStorage.getItem("__c5Conflict"));const p=state.products.find(p=>p.name===d.trackerName);sessionStorage.setItem("__c5ConflictOld",String(p.marketPrice));p.marketPrice+=0.1;GameSync.onTrackerDataChanged();})()' | Out-Null
BrowserCall @('click','#gameSyncApplyBtn') | Out-Null
BrowserCall @('wait','--fn',"document.getElementById('gameSyncReviewError').textContent.length > 0") | Out-Null
Check (Eval '(() => {const d=JSON.parse(sessionStorage.getItem("__c5Conflict"));return document.getElementById("gameSyncReviewError").textContent.includes("changed") && JSON.parse(localStorage.getItem("smtracker_v6")).products.find(p=>p.name===d.trackerName).marketPrice===Number(sessionStorage.getItem("__c5ConflictOld"));})()') 'Concurrent tracker edit blocks stale review apply'
Eval '(() => {const d=JSON.parse(sessionStorage.getItem("__c5Conflict"));state.products.find(p=>p.name===d.trackerName).marketPrice=Number(sessionStorage.getItem("__c5ConflictOld"));GameSync.onTrackerDataChanged();})()' | Out-Null
BrowserCall @('click','#gameSyncCloseReviewBtn') | Out-Null
BrowserCall @('screenshot',(Join-Path $evidence "$Browser-hosted.png")) | Out-Null
$errors = BrowserCall @('errors')
Check ($errors.errors.Count -eq 0) 'No uncaught browser JavaScript errors'
$result = @{browser=$Browser;session=$session;profile=$browserProfile;initial=$initial;checks=$checks;applied=$applied;errors=$errors;result='PASS'}
[IO.File]::WriteAllText((Join-Path $evidence "$Browser-result.json"),($result | ConvertTo-Json -Depth 15))
Write-Output "RESULT $Browser $($checks.Count) passed, 0 failed; session=$session"
