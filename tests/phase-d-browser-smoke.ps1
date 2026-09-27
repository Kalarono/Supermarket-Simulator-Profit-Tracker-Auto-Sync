param([ValidateSet('chrome','edge')][string]$Browser = 'chrome', [int]$Port = 47832, [int]$HelperPort = 47831, [int]$CDPPort = 0,
    [ValidatePattern('^[a-z0-9-]+$')][string]$EvidencePrefix = 'phase-d')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$runId = [guid]::NewGuid().ToString('N').Substring(0,8)
$testStarted = Get-Date
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $tempRoot "smtracker-phase-d-$runId"
$profile = Join-Path $testRoot "$Browser-profile"
$downloads = Join-Path $testRoot 'downloads'
$serverLog = Join-Path $testRoot 'fixture-server.log'
$serverError = Join-Path $testRoot 'fixture-server-error.log'
$session = "phase-d-$Browser-$runId"
$helperUrl = "http://127.0.0.1:$HelperPort"
$fixtureUrl = "http://127.0.0.1:$Port"
$savePath = Join-Path $env:USERPROFILE 'AppData\LocalLow\Nokta Games\Supermarket Simulator\slot_0.es3'
$saveHashBefore = if (Test-Path -LiteralPath $savePath) { (Get-FileHash -Algorithm SHA256 -LiteralPath $savePath).Hash } else { $null }
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
$browserCli = Join-Path (Split-Path (Get-Command agent-browser).Source -Parent) 'node_modules\agent-browser\bin\agent-browser-win32-x64.exe'
$executable = if ($Browser -eq 'chrome') { 'C:\Program Files\Google\Chrome\Application\chrome.exe' } else { 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }
$evidence = Join-Path $repo 'docs\evidence'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$checks = [System.Collections.Generic.List[string]]::new()
$fixtureProcess = $null
$sessionOpened = $false

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
function Wait-Downloaded([string]$Pattern) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $item = Get-ChildItem -LiteralPath $downloads -Filter $Pattern -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $item -and $CDPPort -gt 0) {
            $external = Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE 'Downloads') -Filter $Pattern -File -ErrorAction SilentlyContinue |
                Where-Object LastWriteTime -ge $testStarted | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($external) {
                Move-Item -LiteralPath $external.FullName -Destination (Join-Path $downloads $external.Name)
                $item = Get-Item -LiteralPath (Join-Path $downloads $external.Name)
            }
        }
        if ($item) { return $item.FullName }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Download did not complete: $Pattern"
}
function Update-Fixture($Value) {
    $json = $Value | ConvertTo-Json -Depth 8 -Compress
    Invoke-RestMethod -Method Post -Uri "$fixtureUrl/__test__/update" -ContentType 'application/json' -Body $json -TimeoutSec 10
}

try {
    $fixtureProcess = Start-Process -FilePath (Get-Command node).Source `
        -ArgumentList @((Join-Path $repo 'tests\autosync-fixture-server.js'), [string]$Port) `
        -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput $serverLog -RedirectStandardError $serverError
    $ready = $false
    for ($i=0; $i -lt 40; $i++) {
        try { $health = Invoke-RestMethod -Uri "$fixtureUrl/health" -TimeoutSec 1; if ($health.status -eq 'ok') { $ready=$true; break } } catch {}
        Start-Sleep -Milliseconds 300
    }
    if (-not $ready) { throw 'In-memory fixture did not start. Check the selected browser-test port.' }

    if ($CDPPort -gt 0) {
        & $browserCli --session $session --cdp $CDPPort --download-path $downloads open "$fixtureUrl/"
    } else {
        & $browserCli --session $session --executable-path $executable --profile $profile --download-path $downloads open "$fixtureUrl/"
    }
    if ($LASTEXITCODE -ne 0) { throw "Could not launch isolated $Browser session" }
    $sessionOpened = $true
    BrowserCall @('wait','--fn',"window.GameSync?.getDiagnostics().state === 'connected'") | Out-Null
    $initial = (Eval @'
(() => { const d=GameSync.getDiagnostics(); return JSON.stringify({mode:d.mode,products:d.status.productCount,
slot:d.status.selectedSave,confirmed:d.review.coverage.confirmed,changes:d.review.diffs.length,
averageCostChanges:d.review.diffs.filter(x=>x.field==='averageCost').length,
rows:state.products.length,onboarding:!!document.getElementById('gameSyncMigrationHint'),
defaultMode:localStorage.getItem('smtracker_gameSync_v1')}); })()
'@) | ConvertFrom-Json
    Check ($initial.mode -eq 'review' -and $initial.changes -gt 0 -and $initial.averageCostChanges -gt 0 -and $initial.confirmed -eq 292 -and $initial.onboarding) 'Auto Sync is opt-in; first launch remains Review Changes with all baseline price differences and migration onboarding'
    Eval 'sessionStorage.setItem("__phaseDPreBaseline",localStorage.getItem("smtracker_v6"));' | Out-Null

    BrowserCall @('click',"button[onclick='exportFullBackup()']") | Out-Null
    $backupPath = Wait-Downloaded 'supermarket-tracker-backup-*.json'
    BrowserCall @('tab','t1') | Out-Null
    $backup = Get-Content -LiteralPath $backupPath -Raw | ConvertFrom-Json
    Check ($backup.schemaVersion -eq 2 -and $backup.state.products.Count -gt 250) 'Phase D backup exports the pre-sync tracker state'

    BrowserCall @('select','#gameSyncMode','auto') | Out-Null
    BrowserCall @('wait','--fn',"document.getElementById('gameSyncAutoConfirmModal').classList.contains('open')") | Out-Null
    Check ((Eval 'document.getElementById("gameSyncAutoConfirmModal").textContent.includes("read-only") && document.getElementById("gameSyncAutoConfirmModal").textContent.includes("Average Cost")') -eq $true) 'Auto Sync requires explicit opt-in and explains allowed/forbidden fields'
    BrowserCall @('click','#gameSyncAutoEnableBtn') | Out-Null
    BrowserCall @('wait','--fn',"GameSync.getDiagnostics().state === 'baseline' && document.getElementById('gameSyncReviewModal').classList.contains('open')") | Out-Null
    $baselineGate = Eval @'
(() => {const before=JSON.parse(sessionStorage.getItem('__phaseDPreBaseline'));
const current=JSON.parse(localStorage.getItem('smtracker_v6'));
return JSON.stringify({mode:GameSync.getDiagnostics().mode,state:GameSync.getDiagnostics().state,
diffs:GameSync.getDiagnostics().review.diffs.length,productsUnchanged:JSON.stringify(before.products)===JSON.stringify(current.products),
historyUnchanged:JSON.stringify(before.priceHistory)===JSON.stringify(current.priceHistory),
batchCount:current.gameSyncBatches?.length||0});})()
'@ | ConvertFrom-Json
    Check ($baselineGate.mode -eq 'auto' -and $baselineGate.diffs -eq $initial.changes -and $baselineGate.productsUnchanged -and $baselineGate.historyUnchanged -and $baselineGate.batchCount -eq 0) 'Initial Auto Sync baseline blocks the mass import until the user reviews it'

    BrowserCall @('click','#gameSyncApplyAllBtn') | Out-Null
    BrowserCall @('wait','--fn',"!document.getElementById('gameSyncReviewModal').classList.contains('open')") | Out-Null
    BrowserCall @('wait','--fn',"GameSync.getDiagnostics().mode === 'auto' && state.gameSyncMeta?.baseline?.snapshotId") | Out-Null
    BrowserCall @('select','#gameSyncMode','review') | Out-Null
    BrowserCall @('select','#gameSyncMode','auto') | Out-Null
    BrowserCall @('wait','--fn',"GameSync.getDiagnostics().mode === 'auto' && !document.getElementById('gameSyncAutoConfirmModal').classList.contains('open')") | Out-Null
    Check ((Eval 'GameSync.getDiagnostics().review.diffs.length===0 && localStorage.getItem("smtracker_gameSync_autoConsent_v1")==="yes"') -eq $true) 'After baseline, an intentional mode re-enable does not repeat confirmation or silently Apply changes'
    Eval 'sessionStorage.setItem("__phaseDSemanticBefore",JSON.stringify({products:state.products,history:state.priceHistory,batches:state.gameSyncBatches.length}));state.gameSyncMeta.pricingSchemaVersion=2;state.gameSyncMeta.baseline.pricingSchemaVersion=2;saveState();' | Out-Null
    BrowserCall @('select','#gameSyncMode','auto') | Out-Null
    BrowserCall @('wait','--fn',"GameSync.getDiagnostics().mode === 'auto' && document.getElementById('gameSyncReviewModal').classList.contains('open') && document.getElementById('gameSyncConfirmMigrationBtn')") | Out-Null
    $semanticGate = (Eval '(() => {const before=JSON.parse(sessionStorage.getItem("__phaseDSemanticBefore"));return JSON.stringify({state:GameSync.getDiagnostics().state,diffs:GameSync.getDiagnostics().review.diffs.length,button:!!document.getElementById("gameSyncConfirmMigrationBtn"),productsUnchanged:JSON.stringify(state.products)===JSON.stringify(before.products),historyUnchanged:JSON.stringify(state.priceHistory)===JSON.stringify(before.history),batches:state.gameSyncBatches.length,batchesUnchanged:state.gameSyncBatches.length===before.batches});})()') | ConvertFrom-Json
    Check ($semanticGate.diffs -eq 0 -and $semanticGate.button -and $semanticGate.productsUnchanged -and $semanticGate.historyUnchanged -and $semanticGate.batchesUnchanged) 'Old pricing semantics pause Auto Sync for explicit Review even with zero price differences'
    BrowserCall @('click','#gameSyncConfirmMigrationBtn') | Out-Null
    BrowserCall @('wait','--fn',"state.gameSyncMeta?.baseline?.pricingSchemaVersion === 3 && GameSync.getDiagnostics().state === 'connected'") | Out-Null
    $semanticDone = Eval 'JSON.stringify({version:state.gameSyncMeta.pricingSchemaVersion,baseline:state.gameSyncMeta.baseline.pricingSchemaVersion,diffs:GameSync.getDiagnostics().review.diffs.length,productsUnchanged:JSON.stringify(state.products)===JSON.stringify(JSON.parse(sessionStorage.getItem("__phaseDSemanticBefore")).products),historyUnchanged:JSON.stringify(state.priceHistory)===JSON.stringify(JSON.parse(sessionStorage.getItem("__phaseDSemanticBefore")).history),batches:state.gameSyncBatches.length})' | ConvertFrom-Json
    if (-not ($semanticDone.version -eq 3 -and $semanticDone.baseline -eq 3 -and $semanticDone.diffs -eq 0 -and $semanticDone.productsUnchanged -and $semanticDone.historyUnchanged -and $semanticDone.batches -eq $semanticGate.batches)) { Write-Host ($semanticDone | ConvertTo-Json -Depth 5) }
    Check ($semanticDone.version -eq 3 -and $semanticDone.baseline -eq 3 -and $semanticDone.diffs -eq 0 -and $semanticDone.productsUnchanged -and $semanticDone.historyUnchanged -and $semanticDone.batches -eq $semanticGate.batches) 'Explicit empty Review completes migration without importing or rewriting history'
    $targets = (Eval @'
(() => {const products=GameSync.getDiagnostics().snapshot.products;
const eligible=products.filter(p=>p.gameData?.trackerKey && ['confirmed-exact','confirmed-alias','confirmed-metadata'].includes(p.gameData.auditStatus) && p.marketPrice.status==='present' && p.averageCost.status==='present');
const sell=eligible.find(p=>p.productId===33 && p.playerSellPrice.status==='present') || eligible.find(p=>p.playerSellPrice.status==='present');
const other=eligible.find(p=>p.productId!==sell.productId);
const ids=[sell.productId,other.productId];const rows=ids.map(id=>state.products.find(p=>p.productId===id));
const target={sellId:sell.productId,otherId:other.productId,marketOne:sell.marketPrice.value+0.137,
averageOne:sell.averageCost.value+0.137,
sellPrice:sell.playerSellPrice.value+0.223,marketTwo:other.marketPrice.value+0.191,
before:rows.map(p=>({id:p.productId,name:p.name,market:p.marketPrice,sell:p.yourPrice,online:p.onlineBuyPrice,
pickup:p.pickupBuyPrice,average:p.averageCost,history:(state.priceHistory[p.name]||[]).length}))};
sessionStorage.setItem('__phaseDTargets',JSON.stringify(target));return JSON.stringify(target);})()
'@) | ConvertFrom-Json
    Check ($null -ne $targets.sellId -and $null -ne $targets.otherId -and $targets.averageOne -gt $targets.before[0].average) 'Selected real mapped products with present Average Cost and Player Sell Price'

    $testOne = Update-Fixture @{ changes=@(
        @{productId=[int]$targets.sellId;marketPrice=[double]$targets.marketOne;playerSellPrice=[double]$targets.sellPrice;averageCost=[double]$targets.averageOne},
        @{productId=[int]$targets.otherId;marketPrice=[double]$targets.marketTwo}
    ) }
    BrowserCall @('click','#gameSyncRefreshBtn') | Out-Null
    BrowserCall @('wait','--fn',"GameSync.getDiagnostics().snapshot?.snapshotHash === '$($testOne.status.snapshotHash)' && state.gameSyncMeta?.lastAutoUndo?.snapshotId?.endsWith('|$($testOne.status.snapshotHash)')") | Out-Null
    $appliedOne = (Eval 'JSON.stringify({batch:state.gameSyncBatches.at(-1),undo:state.gameSyncMeta.lastAutoUndo,
targets:JSON.parse(sessionStorage.getItem("__phaseDTargets")),history:state.priceHistory})') | ConvertFrom-Json
    $oneItems = @($appliedOne.undo.products)
    $lastSourcesOk = $true
    foreach ($id in @([int]$targets.sellId,[int]$targets.otherId)) {
        $p = Eval "JSON.stringify(state.products.find(p=>p.productId===$id))" | ConvertFrom-Json
        $h = Eval "JSON.stringify(state.priceHistory['$($p.name)'].at(-1))" | ConvertFrom-Json
        if ($h.source -ne 'game-auto-sync' -or $h.snapshotId -ne $appliedOne.undo.snapshotId -or -not $h.batchId -or $h.averageCostStatus -ne 'present') { $lastSourcesOk=$false }
    }
    Check ($appliedOne.batch.mode -eq 'auto' -and $appliedOne.batch.changeCount -eq 4 -and $appliedOne.batch.productCount -eq 2) 'One valid snapshot commits supplier-independent Average Cost, market and sell changes across 2 products as one Auto Sync batch'
    Check $lastSourcesOk 'History records the sourced Average Cost with the Auto Sync batch/snapshot metadata'
    $autoSafety = (Eval @'
(() => {const t=JSON.parse(sessionStorage.getItem('__phaseDTargets'));return JSON.stringify(t.before.every(b=>{
const p=state.products.find(x=>x.productId===b.id);return p.onlineBuyPrice===b.online && p.pickupBuyPrice===b.pickup &&
p.averageCost===(b.id===t.sellId?t.averageOne:b.average); }));})()
'@) -eq 'true'
    Check $autoSafety 'Average Cost updates from its proven source while Online Buy and Pickup remain untouched'

    Eval 'sessionStorage.setItem("__phaseDAfterFirst",JSON.stringify({state:JSON.parse(localStorage.getItem("smtracker_v6")),batchCount:state.gameSyncBatches.filter(b=>b.mode==="auto").length}));' | Out-Null
    BrowserCall @('reload') | Out-Null
    BrowserCall @('wait','--fn',"window.GameSync?.getDiagnostics().mode === 'auto' && window.GameSync?.getDiagnostics().state === 'connected'") | Out-Null
    BrowserCall @('click','#gameSyncRefreshBtn') | Out-Null
    $duplicate = (Eval @'
(() => {const before=JSON.parse(sessionStorage.getItem('__phaseDAfterFirst'));
const after=JSON.parse(localStorage.getItem('smtracker_v6'));
const batches=state.gameSyncBatches.filter(b=>b.mode==='auto').length;
const snapshot=state.gameSyncMeta.lastAutoUndo?.snapshotId;
const syncedPricesSame=before.state.products.length===after.products.length && before.state.products.every(b=>{
const a=after.products.find(p=>p.name===b.name&&p.productId===b.productId);
return !!a&&a.marketPrice===b.marketPrice&&a.yourPrice===b.yourPrice&&a.averageCost===b.averageCost;});
return JSON.stringify({batchCount:batches,beforeBatchCount:before.batchCount,batches:batches===before.batchCount,
state:syncedPricesSame &&
JSON.stringify(after.priceHistory)===JSON.stringify(before.state.priceHistory),
syncedPricesSame,
historySame:JSON.stringify(after.priceHistory)===JSON.stringify(before.state.priceHistory),
processed:state.gameSyncMeta.processedSnapshotIds.includes(snapshot),snapshot,
processedIds:state.gameSyncMeta.processedSnapshotIds});})()
'@) | ConvertFrom-Json
    if (-not ($duplicate.batches -and $duplicate.state -and $duplicate.processed)) { Write-Host ($duplicate | ConvertTo-Json -Depth 5) }
    Check ($duplicate.batches -and $duplicate.state -and $duplicate.syncedPricesSame -and $duplicate.processed) 'Reload and repeated polling do not reapply synced prices or duplicate history'

    Eval 'sessionStorage.setItem("__phaseD1PurchaseBeforeUndo",JSON.stringify(JSON.parse(sessionStorage.getItem("__phaseDTargets")).before.map(b=>[b.online,b.pickup,b.average])));' | Out-Null
    BrowserCall @('click','#gameSyncUndoBtn') | Out-Null
    $undoSame = (Eval @'
(() => {const t=JSON.parse(sessionStorage.getItem('__phaseDTargets'));
const sell=state.products.find(p=>p.productId===t.sellId), other=state.products.find(p=>p.productId===t.otherId);
return JSON.stringify({snapshot:state.gameSyncMeta.lastAutoUndo.snapshotId,
undone:!!state.gameSyncMeta.lastAutoUndo.undoneAt,processed:state.gameSyncMeta.processedSnapshotIds.includes(state.gameSyncMeta.lastAutoUndo.snapshotId),
suppressed:state.gameSyncMeta.suppressedSnapshotIds?.includes(state.gameSyncMeta.lastAutoUndo.snapshotId),
persistedSuppression:JSON.parse(localStorage.getItem('smtracker_v6')).gameSyncMeta.suppressedSnapshotIds?.includes(state.gameSyncMeta.lastAutoUndo.snapshotId),
        purchaseUnchanged:JSON.stringify([sell,other].map(p=>[p.onlineBuyPrice,p.pickupBuyPrice,p.averageCost]))===sessionStorage.getItem('__phaseD1PurchaseBeforeUndo'),
undoButtonDisabled:document.getElementById('gameSyncUndoBtn').disabled,
sellMarket:sell.marketPrice,sellPrice:sell.yourPrice,otherMarket:other.marketPrice,
batchCount:state.gameSyncBatches.filter(b=>b.mode==='auto').length,
history:JSON.stringify([state.priceHistory[sell.name],state.priceHistory[other.name]])});})()
'@) | ConvertFrom-Json
    $undoPricesRestored = [math]::Abs([double]$undoSame.sellMarket-[double]$targets.before[0].market) -lt 0.000001 -and
        [math]::Abs([double]$undoSame.sellPrice-[double]$targets.before[0].sell) -lt 0.000001 -and
        [math]::Abs([double]$undoSame.otherMarket-[double]$targets.before[1].market) -lt 0.000001
    if (-not ($undoSame.undone -and $undoSame.processed -and $undoSame.suppressed -and
        $undoSame.persistedSuppression -and $undoSame.purchaseUnchanged -and $undoPricesRestored)) {
        Write-Host ($undoSame | ConvertTo-Json -Depth 4)
        Write-Host "Undo price comparison: $undoPricesRestored"
    }
    Check ($undoSame.undone -and $undoSame.processed -and $undoSame.suppressed -and
        $undoSame.persistedSuppression -and $undoSame.purchaseUnchanged -and $undoPricesRestored) 'Undo during active Auto Sync restores prices, preserves purchase values and suppresses the snapshot'
    $checkBefore = [long](Eval 'Date.parse(GameSync.getDiagnostics().lastCheckAt)')
    Eval 'window.__phaseD1Writes=0;window.__phaseD1SetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==="smtracker_v6")window.__phaseD1Writes++;return window.__phaseD1SetItem.call(this,k,v)};' | Out-Null
    BrowserCall @('click','#gameSyncRefreshBtn') | Out-Null
    BrowserCall @('wait','--fn',"new Date(GameSync.getDiagnostics().lastCheckAt).getTime() > $checkBefore") | Out-Null
    $afterUndoPoll = (Eval @'
(() => {const t=JSON.parse(sessionStorage.getItem('__phaseDTargets'));
const sell=state.products.find(p=>p.productId===t.sellId), other=state.products.find(p=>p.productId===t.otherId);
return JSON.stringify({snapshot:state.gameSyncMeta.lastAutoUndo.snapshotId,undone:!!state.gameSyncMeta.lastAutoUndo.undoneAt,
sellMarket:sell.marketPrice,sellPrice:sell.yourPrice,otherMarket:other.marketPrice,
batchCount:state.gameSyncBatches.filter(b=>b.mode==='auto').length,
history:JSON.stringify([state.priceHistory[sell.name],state.priceHistory[other.name]]),
storageWrites:window.__phaseD1Writes,diffs:GameSync.getDiagnostics().review.diffs.length});})()
'@) | ConvertFrom-Json
    Eval 'Storage.prototype.setItem=window.__phaseD1SetItem;delete window.__phaseD1SetItem;' | Out-Null
    Check ($afterUndoPoll.snapshot -eq $undoSame.snapshot -and $afterUndoPoll.undone -and
        $afterUndoPoll.batchCount -eq $undoSame.batchCount -and $afterUndoPoll.history -eq $undoSame.history -and
        $afterUndoPoll.sellMarket -eq $undoSame.sellMarket -and $afterUndoPoll.sellPrice -eq $undoSame.sellPrice -and
        $afterUndoPoll.otherMarket -eq $undoSame.otherMarket -and $afterUndoPoll.storageWrites -eq 0 -and
        $afterUndoPoll.diffs -gt 0) 'Repeated polling suppresses the undone snapshot without another batch, history entry or tracker write'

    $nextMarket = [double]$targets.marketTwo + 0.517
    $afterUndoSave = Update-Fixture @{ changes=@(@{productId=[int]$targets.otherId;marketPrice=$nextMarket}) }
    BrowserCall @('click','#gameSyncRefreshBtn') | Out-Null
    BrowserCall @('wait','--fn',"state.gameSyncMeta?.lastAutoUndo?.snapshotId?.endsWith('|$($afterUndoSave.status.snapshotHash)')") | Out-Null
    $afterNewSave = (Eval "JSON.stringify({snapshot:state.gameSyncMeta.lastAutoUndo.snapshotId,batchCount:state.gameSyncBatches.filter(b=>b.mode==='auto').length,market:state.products.find(p=>p.productId===$($targets.otherId)).marketPrice,historySource:state.priceHistory[state.products.find(p=>p.productId===$($targets.otherId)).name].at(-1).source})") | ConvertFrom-Json
    Check ($afterNewSave.snapshot -ne $undoSame.snapshot -and $afterNewSave.batchCount -eq ($undoSame.batchCount+1) -and
        [math]::Abs([double]$afterNewSave.market-$nextMarket) -lt 0.000001 -and $afterNewSave.historySource -eq 'game-auto-sync') 'A new save after Undo creates a new Auto Sync batch'

    $currentSell = [double](Eval "state.products.find(p=>p.productId===$($targets.sellId)).yourPrice")
    $currentMarket = [double](Eval "state.products.find(p=>p.productId===$($targets.sellId)).marketPrice")
    Eval "sessionStorage.setItem('__phaseDBeforeSparse',JSON.stringify({market:$currentMarket,sell:$currentSell}));" | Out-Null
    $sparse = Update-Fixture @{ changes=@(@{productId=[int]$targets.sellId;marketPrice=([double]$targets.marketOne+0.341);playerSellPriceStatus='absent'}) }
    BrowserCall @('click','#gameSyncRefreshBtn') | Out-Null
    BrowserCall @('wait','--fn',"GameSync.getDiagnostics().snapshot?.snapshotHash === '$($sparse.status.snapshotHash)' && state.gameSyncMeta?.lastAutoUndo?.snapshotId?.endsWith('|$($sparse.status.snapshotHash)')") | Out-Null
    $sparseResult = Eval "JSON.stringify({sell:state.products.find(p=>p.productId===$($targets.sellId)).yourPrice,market:state.products.find(p=>p.productId===$($targets.sellId)).marketPrice,batch:state.gameSyncBatches.at(-1)})" | ConvertFrom-Json
    Check ([math]::Abs([double]$sparseResult.sell-[double]$currentSell) -lt 0.000001 -and $sparseResult.batch.changeCount -eq 1 -and $sparseResult.batch.productCount -eq 1) 'Absent playerSellPrice is NO OP while the present market price syncs'
    Eval 'sessionStorage.setItem("__phaseDBeforeMalformed",JSON.stringify({products:JSON.parse(localStorage.getItem("smtracker_v6")).products,history:JSON.parse(localStorage.getItem("smtracker_v6")).priceHistory,batches:state.gameSyncBatches.length}));' | Out-Null

    $malformed = Update-Fixture @{ malformed='price' }
    BrowserCall @('click','#gameSyncRefreshBtn') | Out-Null
    BrowserCall @('wait','--fn',"GameSync.getDiagnostics().state === 'review' && GameSync.getDiagnostics().pauseReason.includes('malformed')") | Out-Null
    $malformedResult = (Eval @'
(() => {const before=JSON.parse(sessionStorage.getItem('__phaseDBeforeMalformed'));
const after=JSON.parse(localStorage.getItem('smtracker_v6'));
return JSON.stringify({sameProducts:JSON.stringify(before.products)===JSON.stringify(after.products),
sameHistory:JSON.stringify(before.history)===JSON.stringify(after.priceHistory),sameBatches:before.batches===state.gameSyncBatches.length,
status:document.getElementById('gameSyncStatus').textContent,reason:GameSync.getDiagnostics().pauseReason});})()
'@) | ConvertFrom-Json
    Check ($malformedResult.sameProducts -and $malformedResult.sameHistory -and $malformedResult.sameBatches -and $malformedResult.status -like '*paused*') 'Malformed snapshot pauses Auto Sync without changing tracker values, history or batches'

    Update-Fixture @{ clearMalformed=$true } | Out-Null
    BrowserCall @('click','#gameSyncRefreshBtn') | Out-Null
    BrowserCall @('wait','--fn',"document.getElementById('gameSyncResumeBtn').hidden === false") | Out-Null
    BrowserCall @('click','#gameSyncResumeBtn') | Out-Null
    BrowserCall @('wait','--fn',"!state.gameSyncMeta?.hold && GameSync.getDiagnostics().state === 'connected'") | Out-Null
    $beforeSlot = [double](Eval "state.products.find(p=>p.productId===$($targets.otherId)).marketPrice")
    $slotChange = Update-Fixture @{ selectedSave='slot_1.es3';changes=@(@{productId=[int]$targets.otherId;marketPrice=([double]$beforeSlot+0.611)}) }
    BrowserCall @('click','#gameSyncRefreshBtn') | Out-Null
    BrowserCall @('wait','--fn',"GameSync.getDiagnostics().state === 'paused' && GameSync.getDiagnostics().pauseReason.includes('Save slot changed')") | Out-Null
    $slotResult = Eval "JSON.stringify({slot:GameSync.getDiagnostics().status.selectedSave,market:state.products.find(p=>p.productId===$($targets.otherId)).marketPrice,before:$beforeSlot,hold:state.gameSyncMeta.hold?.reason})" | ConvertFrom-Json
    Check ($slotResult.slot -eq 'slot_1.es3' -and $slotResult.market -eq [double]$beforeSlot -and $slotResult.hold -like '*Save slot changed*') 'Save-slot change pauses Auto Sync and does not apply new-slot prices'

    $expectedUndo = Eval "sessionStorage.getItem('__phaseDBeforeSparse')" | ConvertFrom-Json
    BrowserCall @('click','#gameSyncUndoBtn') | Out-Null
    $undo = Eval "JSON.stringify({last:state.gameSyncMeta.lastAutoUndo,latest:state.gameSyncBatches.at(-1),sell:state.products.find(p=>p.productId===$($targets.sellId)).marketPrice,price:state.products.find(p=>p.productId===$($targets.sellId)).yourPrice,source:state.priceHistory[state.products.find(p=>p.productId===$($targets.sellId)).name].at(-1)?.source})" | ConvertFrom-Json
    Check ($undo.last.undoneAt -and $undo.latest.undoneAt -and [math]::Abs([double]$undo.sell-[double]$expectedUndo.market) -lt 0.000001 -and [math]::Abs([double]$undo.price-[double]$expectedUndo.sell) -lt 0.000001) 'Undo Last Sync restores the latest batch values and records rollback'
    BrowserCall @('reload') | Out-Null
    BrowserCall @('wait','--fn',"window.GameSync?.getDiagnostics().mode === 'auto' && window.GameSync?.getDiagnostics().state === 'paused'") | Out-Null
    $undoReload = Eval "JSON.stringify({market:state.products.find(p=>p.productId===$($targets.sellId)).marketPrice,sell:state.products.find(p=>p.productId===$($targets.sellId)).yourPrice,undone:!!state.gameSyncMeta.lastAutoUndo.undoneAt,buttonDisabled:document.getElementById('gameSyncUndoBtn').disabled})" | ConvertFrom-Json
    Check ([math]::Abs([double]$undoReload.market-[double]$expectedUndo.market) -lt 0.000001 -and [math]::Abs([double]$undoReload.sell-[double]$expectedUndo.sell) -lt 0.000001 -and $undoReload.undone -and $undoReload.buttonDisabled) 'Undo values and disabled Undo state survive reload'
    BrowserCall @('screenshot',(Join-Path $evidence "$EvidencePrefix-$Browser.png")) | Out-Null
    $oldBackupDispatch = Eval @'
(() => {const source=state.products.find(p=>p.productId===33)||state.products[0];
const product=JSON.parse(JSON.stringify(source));product.productId=null;
const legacy={schemaVersion:2,state:{products:[product],priceHistory:{[product.name]:[
{date:'Legacy Phase C',marketPrice:product.marketPrice,yourPrice:product.yourPrice,onlineBuyPrice:product.onlineBuyPrice} ]}}};
window.confirm=()=>true;const input=document.getElementById('jsonRestoreInput');const transfer=new DataTransfer();
transfer.items.add(new File([JSON.stringify(legacy)],'phase-c-backup.json',{type:'application/json'}));
Object.defineProperty(input,'files',{configurable:true,value:transfer.files});
input.dispatchEvent(new Event('change',{bubbles:true}));setTimeout(()=>{window.confirm=()=>true;},1000);return 'dispatched';})()
'@
    BrowserCall @('wait','--fn',"state.products.length===1 && state.products[0].productId===null && state.priceHistory[state.products[0].name]?.some(e=>e.date==='Legacy Phase C')") | Out-Null
    $legacyRestore = Eval 'JSON.stringify({rows:state.products.length,id:state.products[0].productId,history:state.priceHistory[state.products[0].name],onboarding:!!document.getElementById("gameSyncMigrationHint"),mode:GameSync.getDiagnostics().mode})' | ConvertFrom-Json
    Check ($legacyRestore.rows -eq 1 -and $null -eq $legacyRestore.id -and $legacyRestore.history.Count -gt 0 -and -not $legacyRestore.onboarding -and $legacyRestore.mode -eq 'review') 'Pre-Game-Sync Phase C backup restores history, keeps optional ProductID null and dismisses migration hint'
    $browserErrors = BrowserCall @('errors')
    Check ($browserErrors.errors.Count -eq 0) 'No uncaught browser JavaScript errors'

    $saveHashAfter = if (Test-Path -LiteralPath $savePath) { (Get-FileHash -Algorithm SHA256 -LiteralPath $savePath).Hash } else { $null }
    Check ($saveHashBefore -eq $saveHashAfter) 'Real game save SHA-256 unchanged throughout fixture/browser validation'
    $result = @{browser=$Browser;session=$session;saveHashBefore=$saveHashBefore;saveHashAfter=$saveHashAfter;
        checks=$checks;initial=$initial;autoBatch=$appliedOne.batch;malformed=$malformedResult;slot=$slotResult;undo=$undoReload;legacyRestore=$legacyRestore;errors=$browserErrors;result='PASS'}
    [IO.File]::WriteAllText((Join-Path $evidence "$EvidencePrefix-$Browser.json"),($result | ConvertTo-Json -Depth 15))
    Write-Output "RESULT $Browser $($checks.Count) passed, 0 failed"
}
finally {
    if ($sessionOpened) { try { BrowserCall @('close') | Out-Null } catch {} }
    if ($fixtureProcess -and -not $fixtureProcess.HasExited) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($fixtureProcess.Id)"
        if ($proc -and $proc.CommandLine -like "*$([IO.Path]::GetFullPath((Join-Path $repo 'tests\autosync-fixture-server.js')))*") {
            Stop-Process -Id $fixtureProcess.Id -Force
        }
    }
    $fullTestRoot=[IO.Path]::GetFullPath($testRoot)
    if ($fullTestRoot.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($fullTestRoot) -eq "smtracker-phase-d-$runId" -and (Test-Path -LiteralPath $fullTestRoot)) {
        Remove-Item -LiteralPath $fullTestRoot -Recurse -Force
    }
}
