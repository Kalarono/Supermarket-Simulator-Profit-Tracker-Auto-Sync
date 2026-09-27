const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { GameSyncClient, ApiSchemaError, ApiResponseError, validateProducts,
  buildReview, pricesEqual, fingerprint, normalizePreferences, shouldSuppressDiff,
  backupLegacyState, runAtomicApply, mappingAuditExport, validateAutoSyncSnapshot,
  autoSyncDecision, whitelistAutoDiffs, calculateInventoryProfit } = require('../src/game-sync.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS', name); passed++; }
  catch (error) { console.error('FAIL', name, error); failed++; }
}
const saveTime = '2026-09-25T01:13:43.737Z';
const snapshotHash = 'a'.repeat(64);
const status = { schemaVersion: 3, connected: true, selectedSave: 'slot_0.es3',
  lastSaveWriteTime: saveTime, lastSuccessfulParse: new Date().toISOString(), snapshotHash,
  productCount: 1, gameVersion: 'v1.6.0(223)', warnings: [] };
const field = (id, array, value, state = 'present') => ({ value: state === 'present' ? value : null,
  status: state, source: state === 'present' ? `Price.value.${array}[${id}].Price` : null });
const game = (id = 33, key = 'Cereal - Chokipik', supplier = 4.116, player = 9.05, average = null) => ({
  productId: id,
  purchaseQuantity: { value: 12, status: 'present', source: `game-data:ProductSO[${id}].PurchaseQuantity` },
  supplierUnitPrice: field(id, 'PricingDatas', supplier),
  supplierBoxPrice: { value: Number((supplier * 12).toFixed(6)), status: 'present',
    source: `derived:Price.value.PricingDatas[${id}].Price*ProductSO[${id}].PurchaseQuantity`,
    derivedFrom: ['supplierUnitPrice', 'gameData.purchaseQuantity'] },
  marketPrice: { value: Math.round(supplier * 200) / 100, status: 'present',
    source: `derived:Pricing[${id}].MarketPrice`,
    derivedFrom: ['supplierUnitPrice', 'gameData.optimumProfitRate'] },
  averageCost: average == null ? field(id, 'AverageCosts', null, 'absent') : field(id, 'AverageCosts', average),
  playerSellPrice: player == null ? field(id, 'PricesSetByPlayer', null, 'absent') :
    field(id, 'PricesSetByPlayer', player),
  activeInProductList: { value: null, status: 'absent', source: null },
  gameData: { productId: id, assetName: `${id}_Cereal_Chokipik`,
    trackerKey: key, mappingStatus: key ? 'mapped' : 'unmapped',
    auditStatus: key ? 'confirmed-exact' : 'unmapped' },
});
const tracker = (name = 'Cereal - Chokipik', marketPrice = 4.02, yourPrice = 8.8) =>
  ({ name, marketPrice, yourPrice, onlineBuyPrice: 35.88, supplierUnitPrice: null, averageCost: null, productId: null });
function mockClient(parts) {
  const response = value => ({ ok: true, json: async () => value });
  return new GameSyncClient('http://127.0.0.1:47831', 100,
    async url => response(parts[url.slice(url.lastIndexOf('/'))]));
}
function snapshot(gameProducts = [game()]) {
  return { schemaVersion: 3, snapshotHash, sourceSave: status.selectedSave,
    saveWriteTimeUtc: status.lastSaveWriteTime, parsedAtUtc: new Date().toISOString(),
    products: gameProducts, unlockedLicenses: [], activeLicenses: [] };
}

(async () => {
  await test('API unavailable is isolated', async () => {
    const client = new GameSyncClient('http://127.0.0.1:47831', 100,
      async () => { throw new TypeError('offline'); });
    await assert.rejects(client.check(), TypeError);
  });
  await test('malformed API response rejected', async () => {
    const client = mockClient({ '/health': { schemaVersion: 3, status: 'ok' },
      '/status': status, '/snapshot': { ...snapshot(), products: 'bad' } });
    await assert.rejects(client.check(), ApiResponseError);
  });
  await test('unchanged save polls reuse the validated snapshot and a new hash fetches again', async () => {
    let currentStatus={...status}, currentSnapshot=snapshot(), snapshotReads=0;
    const client=new GameSyncClient('http://127.0.0.1:47831',100,async url=>{
      const path=url.slice(url.lastIndexOf('/'));
      const value=path==='/health'?{schemaVersion:3,status:'ok'}:path==='/status'?currentStatus:
        (snapshotReads++,currentSnapshot);
      return {ok:true,json:async()=>value};
    });
    const first=await client.check(), repeated=await client.check();
    assert.equal(snapshotReads,1);assert.equal(first.unchanged,false);assert.equal(repeated.unchanged,true);
    currentStatus={...currentStatus,lastSaveWriteTime:'2026-09-25T02:00:00.000Z',snapshotHash:'b'.repeat(64)};
    currentSnapshot={...currentSnapshot,saveWriteTimeUtc:currentStatus.lastSaveWriteTime,snapshotHash:currentStatus.snapshotHash};
    const changed=await client.check();assert.equal(snapshotReads,2);assert.equal(changed.unchanged,false);
  });
  await test('a rejected snapshot identity is not downloaded repeatedly', async () => {
    let reads=0;
    const client=new GameSyncClient('http://127.0.0.1:47831',100,async url=>{
      const path=url.slice(url.lastIndexOf('/'));
      const value=path==='/health'?{schemaVersion:3,status:'ok'}:path==='/status'?status:
        (reads++,{...snapshot(),products:'malformed'});
      return {ok:true,json:async()=>value};
    });
    await assert.rejects(client.check(),ApiResponseError);
    await assert.rejects(client.check(),ApiResponseError);
    assert.equal(reads,1);
  });
  await test('incompatible schemaVersion rejected', async () => {
    const client = mockClient({ '/health': { schemaVersion: 1, status: 'ok' } });
    await assert.rejects(client.check(), ApiSchemaError);
  });
  await test('confirmed ProductID separates supplier, box, market and sell diffs', async () => {
    const result = buildReview([game()], [tracker()]);
    assert.equal(result.coverage.confirmed, 1);
    assert.deepEqual(result.diffs.map(d => d.field), ['supplierUnitPrice', 'onlineBuyPrice', 'marketPrice', 'yourPrice']);
    assert.equal(result.diffs[0].source, 'Price.value.PricingDatas[33].Price');
  });
  await test('ProductID 128 Average Cost is a distinct saved field and pricing basis', () => {
    const rice = game(128, 'Rice Basmati - Lustupacru', 3.39, 6.52, 3.99999833);
    rice.purchaseQuantity.value = 10;
    rice.supplierBoxPrice.value = 33.9;
    rice.marketPrice.value = 5.93;
    rice.gameData.assetName = '128_RiceBasmati_Lustupacru';
    const item = tracker('Rice Basmati - Lustupacru', 5.93, 6.52);
    item.onlineBuyPrice = 33.9;
    const review = buildReview([rice], [item]);
    assert.deepEqual(review.diffs.map(d => d.field), ['supplierUnitPrice', 'averageCost']);
    assert.equal(review.diffs.find(d => d.field === 'averageCost').source, 'Price.value.AverageCosts[128].Price');
    assert.ok(Math.abs(calculateInventoryProfit(6.52, 3.99999833) - 2.52000167) < 1e-10);
    assert.equal(calculateInventoryProfit(6.52, null), null);
    assert.ok(Math.abs(calculateInventoryProfit(6.52, 3.99999833, 10) - 1.86800167) < 1e-10);
    const newPurchaseItemProfit = 6.52 - 3.39;
    const newPurchaseBoxProfit = 6.52 * 10 - 33.9;
    const marketDeviation = (6.52 - 5.93) / 5.93 * 100;
    assert.ok(Math.abs(newPurchaseItemProfit - 3.13) < 1e-10);
    assert.ok(Math.abs(newPurchaseBoxProfit - 31.30) < 1e-10);
    assert.ok(Math.abs(marketDeviation - 9.9494) < 0.001);
    assert.equal(validateProducts({schemaVersion:3,products:[rice]}, {...status,productCount:1}), undefined);
  });
  await test('active product list field accepts confirmed green/red and preserves unknown as neutral', () => {
    const active = game(), inactive = game(70), unknown = game(147);
    active.activeInProductList = { value: true, status: 'present',
      source: 'Progression.value.LicenseProductsDatas[*].DisabledProductIDs' };
    inactive.activeInProductList = { value: false, status: 'present',
      source: 'Progression.value.LicenseProductsDatas[*].DisabledProductIDs' };
    const products = [active, inactive, unknown];
    assert.equal(validateProducts({schemaVersion:3,products}, {...status,productCount:3}), undefined);
    active.activeInProductList.value = 'yes';
    assert.throws(() => validateProducts({schemaVersion:3,products}, {...status,productCount:3}), ApiResponseError);
    active.activeInProductList = { value: null, status: 'absent', source: null };
    assert.equal(validateProducts({schemaVersion:3,products}, {...status,productCount:3}), undefined);
  });
  await test('Market deviation and new purchase profit consume their own price bases', () => {
    const html=fs.readFileSync(path.join(__dirname,'..','supermarketSimulator-tracker_v2_9.html'),'utf8');
    const profit=html.slice(html.indexOf('function calcFromPrices('),html.indexOf('function calcStars('));
    const margin=html.slice(html.indexOf('function calcMarginPct('),html.indexOf('const SWEET_SPOT_KEY'));
    const context=vm.createContext({});vm.runInContext(profit+margin,context);
    const purchase=context.calcFromPrices(6.52,33.9,10,null,false,3.39,null,10);
    assert.equal(purchase.onlineItemProfit,3.13);assert.equal(purchase.onlineBoxProfit,31.3);
    const deviation=context.calcMarginPct(6.52,5.93,3.39,3.99999833);
    assert.ok(Math.abs(deviation-9.9494)<0.001);
    assert.equal(context.calcMarginPct.length,2);
    assert.notEqual(3.39,3.99999833);assert.notEqual(3.39,5.93);assert.notEqual(3.99999833,5.93);
  });
  await test('unmapped ProductID cannot create applicable diff', async () => {
    const result = buildReview([game(34, null)], [tracker()]);
    assert.equal(result.coverage.confirmed, 0);
    assert.equal(result.diffs.length, 0);
  });
  await test('ambiguous tracker name cannot create applicable diff', async () => {
    const result = buildReview([game()], [tracker(), tracker()]);
    assert.equal(result.coverage.ambiguous, 1);
    assert.equal(result.diffs.length, 0);
  });
  await test('sparse playerSellPrice null never produces sell diff', async () => {
    const result = buildReview([game(33, 'Cereal - Chokipik', 4.116, null)], [tracker()]);
    assert.deepEqual(result.diffs.map(d => d.field), ['supplierUnitPrice', 'onlineBuyPrice', 'marketPrice']);
  });
  await test('supplier price keeps raw precision while market has game rounding', async () => {
    assert.equal(pricesEqual(4.116, 4.12), false);
    assert.equal(pricesEqual(4.116, 4.1160000001), true);
    const review=buildReview([game()], [tracker('Cereal - Chokipik', 8.23, 9.05)]);
    assert.equal(review.diffs.find(d=>d.field==='supplierUnitPrice').to,4.116);
    assert.equal(review.diffs.find(d=>d.field==='onlineBuyPrice').to,49.392);
    assert.equal(review.diffs.some(d=>d.field==='marketPrice'),false);
  });
  await test('ignore lasts only for one snapshot fingerprint', async () => {
    const first = fingerprint(status, [game()]);
    const restarted = fingerprint({ ...status, lastSuccessfulParse: 'later' }, [game()]);
    const changed = fingerprint(status, [game(33, 'Cereal - Chokipik', 4.2)]);
    assert.equal(first, restarted);
    assert.equal(shouldSuppressDiff(first, first), true);
    assert.equal(shouldSuppressDiff(first, changed), false);
    const avgFirst = fingerprint(status, [game(33, 'Cereal - Chokipik', 4.116, 9.05, 3.9)]);
    const avgChanged = fingerprint(status, [game(33, 'Cereal - Chokipik', 4.116, 9.05, 4.0)]);
    assert.notEqual(avgFirst, avgChanged);
  });
  await test('game-only Bakery product is separately reported', async () => {
    const baked = game(274, null, 5, null);
    baked.gameData.assetName = '274_Bagel_Baked';
    const result = buildReview([baked], [tracker()]);
    assert.equal(result.coverage.bakeryGameOnly, 1);
    assert.equal(result.diffs.length, 0);
  });
  await test('duplicate API ProductID rejected', async () => {
    assert.throws(() => validateProducts({ schemaVersion: 3, products: [game(), game()] },
      { ...status, productCount: 2 }), ApiResponseError);
  });
  await test('apply selected groups price fields and keeps raw box price', async () => {
    const item = tracker();
    const state = { products: [item], priceHistory: { [item.name]: [] } };
    const selected = buildReview([game()], [item]).diffs;
    let updateCalls = 0, saved = false;
    const result = runAtomicApply({ trackerState: state, selected, batchId: 'batch-1',
      selectedSave: 'slot_0.es3', snapshotFingerprint: 'fp',
      update: (p, m, b, yp, meta) => {
        updateCalls++; p.marketPrice = m; p.yourPrice = yp; p.onlineBuyPrice=b;
        p.supplierUnitPrice=meta.supplierUnitPrice;
        state.priceHistory[p.name].push({ marketPrice: m, yourPrice: yp, onlineBuyPrice: b,
          source: meta.source, productId: meta.productId, batchId: meta.batchId });
      }, recalc: () => {}, persist: () => { saved = true; }, afterCommit: () => {},
      restore: () => { throw new Error('unexpected rollback'); } });
    assert.equal(result.changeCount, 4);
    assert.equal(updateCalls, 1);
    assert.equal(saved, true);
    assert.equal(item.onlineBuyPrice, 49.392);
    assert.equal(item.supplierUnitPrice, 4.116);
    assert.equal(state.priceHistory[item.name][0].source, 'game-review-sync');
    assert.equal(item.productId, 33);
  });
  await test('Average Cost applies independently and absent cost remains preserved', () => {
    const rice=game(128,'Rice Basmati - Lustupacru',3.39,6.52,3.99999833);
    const item=tracker('Rice Basmati - Lustupacru',5.93,6.52);item.averageCost=3.7;item.productId=128;
    let received;
    const state={products:[item],priceHistory:{[item.name]:[]}};
    const avgDiff=buildReview([rice],[item]).diffs.find(d=>d.field==='averageCost');
    runAtomicApply({trackerState:state,selected:[avgDiff],batchId:'avg',selectedSave:'slot_0.es3',snapshotFingerprint:'fp',
      update:(p,m,b,y,options)=>{received=options;p.averageCost=options.averageCost;},recalc:()=>{},persist:()=>{},restore:()=>{throw Error('rollback');}});
    assert.equal(received.averageCost,3.99999833);assert.equal(received.averageCostStatus,'present');
    assert.equal(item.averageCost,3.99999833);assert.equal(state.gameSyncMeta.pricingSchemaVersion,3);
    const sparse=game(128,'Rice Basmati - Lustupacru',3.39,6.52,null);
    const sparseDiff=buildReview([sparse],[item]).diffs.find(d=>d.field==='supplierUnitPrice');
    let sparseOptions;
    runAtomicApply({trackerState:state,selected:[sparseDiff],batchId:'sparse',selectedSave:'slot_0.es3',snapshotFingerprint:'fp2',
      update:(p,m,b,y,options)=>{sparseOptions=options;},recalc:()=>{},persist:()=>{},restore:()=>{throw Error('rollback');}});
    assert.equal(Object.hasOwn(sparseOptions,'averageCost'),false);
    assert.equal(sparseOptions.averageCostStatus,'absent');assert.equal(item.averageCost,3.99999833);
  });
  await test('apply rollback on persistence failure', async () => {
    let state = { products: [tracker()], priceHistory: { 'Cereal - Chokipik': [] } };
    const old = JSON.stringify(state);
    assert.throws(() => runAtomicApply({ trackerState: state,
      selected: buildReview([game()], state.products).diffs, batchId: 'x', selectedSave: 'slot_0.es3',
      snapshotFingerprint: 'fp', update: p => { p.marketPrice = 99; }, recalc: () => {},
      persist: () => { throw new Error('quota'); }, afterCommit: () => {},
      restore: backup => { state = backup; } }), /quota/);
    assert.equal(JSON.stringify(state), old);
  });
  await test('unconfirmed change rejected during apply', async () => {
    let state = { products: [tracker()], priceHistory: {} };
    assert.throws(() => runAtomicApply({ trackerState: state,
      selected: [{ productId: 34, trackerName: 'Cereal - Chokipik', field: 'marketPrice',
        to: 5, mappingStatus: 'unmapped' }], batchId: 'x', selectedSave: 'slot_0.es3',
      snapshotFingerprint: 'fp', update: () => {}, recalc: () => {}, persist: () => {},
      afterCommit: () => {}, restore: backup => { state = backup; } }), /Unconfirmed/);
  });
  await test('old localStorage state backed up exactly once', async () => {
    const values = new Map([['smtracker_v6', '{"old":true}']]);
    const storage = { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value) };
    backupLegacyState(storage, 'smtracker_v6', 'backup');
    values.set('smtracker_v6', '{"new":true}');
    backupLegacyState(storage, 'smtracker_v6', 'backup');
    assert.equal(values.get('backup'), '{"old":true}');
  });
  await test('legacy preferences default to Review Changes', async () => {
    assert.deepEqual(normalizePreferences(null), { mode: 'review', ignoredFingerprint: null, notifyAfterAutoSync: true });
    assert.equal(normalizePreferences({ mode: 'read-only' }).mode, 'read-only');
    assert.equal(normalizePreferences({ mode: 'auto' }).mode, 'auto');
  });
  await test('old and new CSV remain importable', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'supermarketSimulator-tracker_v2_9.html'), 'utf8');
    const code = html.slice(html.indexOf('function splitCSVLine('), html.indexOf('function importCSV()'));
    const context = vm.createContext({ buildName: (a, b) => b === '-' ? a : `${a} - ${b}`,
      calcFromPrices: () => ({ onlineItemProfit: 1, onlineBoxProfit: 2,
        pickupItemProfit: 3, pickupBoxProfit: 4, boxDiff: 5 }) });
    vm.runInContext(code, context);
    const old = '0,Cereal,Chokipik,Shelf,12,12,5.98,35.88,Deli and Grocery,true,false,false,';
    assert.equal(context.parseCSVRows(old).products[0].productId, null);
    assert.equal(context.parseCSVRows(old + ',33').products[0].productId, 33);
  });
  await test('legacy JSON backup migration keeps history', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'supermarketSimulator-tracker_v2_9.html'), 'utf8');
    const code = html.slice(html.indexOf('function migrateProducts('), html.indexOf('let _rawDefaultBuyPriceMap'));
    const context = vm.createContext({}); vm.runInContext(code, context);
    const old = JSON.parse('{"version":"smtracker_v6","state":{"products":[{"name":"Cereal - Chokipik"}],"priceHistory":{"Cereal - Chokipik":[{"marketPrice":5.98}]}}}');
    const migrated = context.migrateProducts(old.state.products);
    assert.equal(migrated[0].productId, null);
    assert.equal(migrated[0].cat, 'Cereal');
    assert.equal(old.state.priceHistory['Cereal - Chokipik'][0].marketPrice, 5.98);
  });
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname,'../data/product-map.json'),'utf8'));
  const audit = JSON.parse(fs.readFileSync(path.join(__dirname,'../data/mapping-audit.json'),'utf8'));
  await test('reviewed alias contains evidence and resolves ProductID', () => {
    const alias = catalog.find(p => p.productId === 24);
    assert.equal(alias.trackerKey, 'Bottled Water - Aoette');
    assert.equal(alias.auditStatus, 'confirmed-alias');
    assert.ok(alias.reason && alias.source && alias.metadata.gameLicenses.length);
  });
  await test('metadata mapping validates category brand and license', () => {
    const p = catalog.find(p => p.productId === 196);
    assert.equal(p.auditStatus, 'confirmed-metadata');
    assert.equal(p.license, 'DLC-Clothing-2');
    assert.equal(p.metadata.scriptType, 'ProductSO');
  });
  await test('WeightedProductSO explains formerly missing asset IDs', () => {
    const p=catalog.find(p=>p.productId===165);
    assert.equal(p.trackerKey,'Apple'); assert.equal(p.metadata.scriptType,'WeightedProductSO');
    assert.equal(audit.missingProductSO.length,0);
  });
  await test('Brown versus Blonde conflict remains ambiguous', () => {
    const p=catalog.find(p=>p.productId===4);
    const g=game(4);g.gameData=p;
    assert.equal(p.auditStatus,'ambiguous');
    const review=buildReview([g],[tracker('Beer Blonde Ale - 6 pack - BK')]);
    assert.equal(review.diffs.length,0); assert.equal(review.coverage.ambiguous,1);
  });
  await test('catalog has no duplicate confirmed ProductID or tracker key', () => {
    assert.equal(new Set(catalog.map(p=>p.productId)).size,catalog.length);
    const confirmed=catalog.filter(p=>p.mappingStatus==='mapped');
    assert.equal(new Set(confirmed.map(p=>p.trackerKey)).size,confirmed.length);
  });
  await test('expanded diff only includes confirmed catalog products', () => {
    const products=audit.gameProducts.map(p=>({...game(p.productId,p.trackerKey,1.5,null),gameData:p}));
    const trackers=audit.trackerProducts.map(p=>tracker(p.trackerKey,2,3));
    const review=buildReview(products,trackers);
    assert.equal(review.coverage.confirmed,292); assert.equal(review.diffs.length,876);
    assert.equal(review.coverage.bakeryGameOnly,15); assert.equal(review.coverage.ambiguous,2);
    assert.equal(review.coverage.trackerUnmapped,2);
  });
  await test('full mapping audit export retains reasons and tracker-only rows', () => {
    const products=audit.gameProducts.map(p=>({...game(p.productId,p.trackerKey),gameData:p}));
    const review=buildReview(products,audit.trackerProducts.map(p=>tracker(p.trackerKey)));
    const out=JSON.parse(JSON.stringify(mappingAuditExport(review)));
    assert.equal(out.products.length,311);
    assert.equal(out.products.filter(p=>p.status==='tracker-only / unmapped').length,2);
    assert.ok(out.products.find(p=>p.productId===24).reason);
  });
  await test('missing ProductSO remains informational only', () => {
    const g=game(999); g.gameData=null;
    const review=buildReview([g],[tracker()]);
    assert.equal(review.diffs.length,0); assert.equal(review.coverage.unknownProductSO,1);
  });
  await test('contradictory API confirmation status fails closed', () => {
    const g=game(); g.gameData.auditStatus='ambiguous';
    assert.throws(()=>validateProducts({schemaVersion:3,products:[g]},status),ApiResponseError);
    assert.equal(buildReview([g],[tracker()]).diffs.length,0);
  });
  await test('ProductID already assigned to another row blocks diff and explains conflict', () => {
    const other=tracker('User renamed row');other.productId=33;
    const review=buildReview([game()],[tracker(),other]);
    assert.equal(review.diffs.length,0);assert.equal(review.coverage.ambiguous,1);
    assert.match(review.issues[0].reason,/conflicts/);
  });
  await test('snapshot requires matching SHA-256 save identity and accepts unchanged long-lived saves', () => {
    const oldParsed = snapshot(); oldParsed.parsedAtUtc = '2026-09-25T02:00:00.000Z';
    const oldStatus = { ...status, lastSaveWriteTime: '2026-09-25T01:00:00.000Z' };
    assert.equal(validateAutoSyncSnapshot(oldStatus, { ...oldParsed,
      saveWriteTimeUtc: oldStatus.lastSaveWriteTime }, Date.parse('2026-09-25T18:00:00.000Z')),
      `slot_0.es3|${oldStatus.lastSaveWriteTime}|${snapshotHash}`);
    assert.throws(() => validateAutoSyncSnapshot(status, { ...snapshot(), snapshotHash: 'bad' }), ApiResponseError);
  });
  await test('malformed, stale-before-save and invalid-price snapshots fail closed', () => {
    assert.throws(() => validateAutoSyncSnapshot({ ...status, productCount: 2 }, snapshot()), ApiResponseError);
    const beforeWrite = snapshot(); beforeWrite.parsedAtUtc = '2026-09-25T00:00:00.000Z';
    assert.throws(() => validateAutoSyncSnapshot(status, beforeWrite), ApiResponseError);
    const invalid = game(); invalid.marketPrice = field(33, 'PricingDatas', null, 'invalid');
    assert.throws(() => validateAutoSyncSnapshot(status, snapshot([invalid])), ApiResponseError);
  });
  await test('Auto Sync whitelist allows confirmed present price fields only', () => {
    const changes = buildReview([game()], [tracker()]).diffs;
    assert.equal(whitelistAutoDiffs(changes, [game()]).length, 4);
    const untrusted = game(); untrusted.gameData.auditStatus = 'ambiguous';
    assert.equal(whitelistAutoDiffs(changes, [untrusted]).length, 0);
    assert.equal(whitelistAutoDiffs([{ ...changes[0], field: 'averageCost' }], [game()]).length, 0);
    const rice=game(128,'Rice Basmati - Lustupacru',3.39,6.52,3.99999833);
    const avgDiff=buildReview([rice],[tracker('Rice Basmati - Lustupacru')]).diffs.find(d=>d.field==='averageCost');
    assert.equal(whitelistAutoDiffs([avgDiff],[rice]).length,1);
    rice.averageCost.source='Price.value.PricingDatas[128].Price';
    assert.equal(whitelistAutoDiffs([avgDiff],[rice]).length,0);
    const nonSave = game(); nonSave.supplierUnitPrice.source = 'manual';
    assert.equal(whitelistAutoDiffs([changes[0]], [nonSave]).length, 0);
  });
  await test('absent playerSellPrice is a no-op and never clears tracker price', () => {
    const g=game(33,'Cereal - Chokipik',4.116,null), p=tracker();
    const review=buildReview([g],[p]);
    assert.deepEqual(review.diffs.map(d=>d.field),['supplierUnitPrice','onlineBuyPrice','marketPrice']);
    assert.equal(p.yourPrice,8.8);
  });
  await test('initial Auto Sync has no baseline auto-apply decision', () => {
    const review=buildReview([game()],[tracker()]);
    assert.equal(autoSyncDecision({status,snapshot:snapshot(),review,baseline:null}).action,'baseline-review');
    assert.equal(normalizePreferences(null).mode,'review');
  });
  await test('absent AverageCosts is a no-op and never clears a known tracker value', () => {
    const g=game(), p=tracker();p.averageCost=3.75;
    const review=buildReview([g],[p]);
    assert.equal(review.diffs.some(d=>d.field==='averageCost'),false);
    assert.equal(p.averageCost,3.75);
  });
  await test('legacy Auto Sync baseline requires semantic Migration Review', () => {
    const review=buildReview([game()],[tracker()]);
    const legacy={selectedSave:'slot_0.es3',productCount:1,confirmedMappings:1,
      ambiguousMappings:0,gameUnmapped:0,gameVersion:status.gameVersion};
    const decision=autoSyncDecision({status,snapshot:snapshot(),review,baseline:legacy});
    assert.equal(decision.action,'review');
    assert.match(decision.reason,/Price semantics changed/);
  });
  await test('pricing schema migration still requires Review with zero price changes', () => {
    const cleanGame=game(33,'Cereal - Chokipik',4.116,9.05);
    const cleanTracker=tracker('Cereal - Chokipik',8.23,9.05);
    cleanTracker.supplierUnitPrice=4.116;cleanTracker.onlineBuyPrice=49.392;
    const review=buildReview([cleanGame],[cleanTracker]);assert.equal(review.diffs.length,0);
    const baseline={selectedSave:'slot_0.es3',productCount:1,confirmedMappings:1,ambiguousMappings:0,
      gameUnmapped:0,gameVersion:status.gameVersion,pricingSchemaVersion:2};
    const decision=autoSyncDecision({status,snapshot:snapshot([cleanGame]),review,baseline});
    assert.equal(decision.action,'review');assert.match(decision.reason,/Average Cost/);
  });
  await test('semantic migration preserves existing history and pickup', () => {
    const p=tracker();p.pickupBuyPrice=17.94;
    const legacy={date:'Earlier',savedAt:1,marketPrice:4.116,onlineBuyPrice:49.39,source:'game-review-sync'};
    const state={products:[p],priceHistory:{[p.name]:[structuredClone(legacy)]},gameSyncMeta:{}};
    const selected=buildReview([game()],[p]).diffs;
    runAtomicApply({trackerState:state,selected,batchId:'migration',selectedSave:'slot_0.es3',
      snapshotFingerprint:'fp',update:(item,m,b,y,meta)=>{
        item.marketPrice=m;item.onlineBuyPrice=b;item.yourPrice=y;item.supplierUnitPrice=meta.supplierUnitPrice;
        state.priceHistory[item.name].push({marketPrice:m,onlineBuyPrice:b,yourPrice:y,source:meta.source});
      },recalc:()=>{},persist:()=>{},restore:()=>{throw Error('rollback');}});
    assert.deepEqual(state.priceHistory[p.name][0],legacy);
    assert.equal(p.pickupBuyPrice,17.94);
    assert.equal(state.gameSyncMeta.pricingSchemaVersion,3);
    assert.ok(state.gameSyncMeta.semanticMigrationAt);
  });
  await test('save slot switch pauses and stable game-version change is explicitly classified', () => {
    const cleanGame=game(33,'Cereal - Chokipik',4.02,8.8), cleanTracker=tracker('Cereal - Chokipik',8.04,8.8);
    cleanTracker.supplierUnitPrice=4.02;cleanTracker.onlineBuyPrice=48.24;
    const review=buildReview([cleanGame],[cleanTracker]);
    const base={selectedSave:'slot_0.es3',productCount:1,confirmedMappings:1,ambiguousMappings:0,gameUnmapped:0,gameVersion:'v1',pricingSchemaVersion:3};
    const switched={...status,selectedSave:'slot_1.es3'};
    assert.equal(autoSyncDecision({status:switched,snapshot:{...snapshot([cleanGame]),sourceSave:'slot_1.es3'},review,baseline:base}).action,'pause');
    assert.equal(autoSyncDecision({status:{...status,gameVersion:'v2'},snapshot:snapshot([cleanGame]),review,baseline:base}).action,'version-changed');
  });
  await test('catastrophic changed-product ratio requires Review', () => {
    const games=[], trackers=[];
    for(let id=1;id<=20;id++){const name=`Item ${id}`;games.push(game(id,name,2,3));trackers.push(tracker(name,1,3));}
    const status20={...status,productCount:20};
    const save20={...snapshot(games),products:games};
    const review=buildReview(games,trackers);
    const baseline={selectedSave:'slot_0.es3',productCount:20,confirmedMappings:20,ambiguousMappings:0,gameUnmapped:0,gameVersion:status.gameVersion,pricingSchemaVersion:3};
    assert.equal(autoSyncDecision({status:status20,snapshot:save20,review,baseline}).action,'review');
  });
  await test('Auto Sync atomic batch changes supplier/box/market/sell, preserves pickup and is idempotent', () => {
    const p=tracker();p.pickupBuyPrice=19.4;p.averageCost=3.12;
    const state={products:[p],priceHistory:{[p.name]:[]},gameSyncMeta:{processedSnapshotIds:[]}};
    const diffs=buildReview([game()],[p]).diffs, snapshotId='slot_0.es3|write|hash';
    let persists=0,recalcs=0;
    const args={trackerState:state,selected:diffs,batchId:'auto-1',selectedSave:'slot_0.es3',snapshotFingerprint:snapshotId,snapshotId,
      mode:'auto',source:'game-auto-sync',undoRecord:{batchId:'auto-1',products:[]},
      update:(x,m,b,y,meta)=>{x.marketPrice=m;x.yourPrice=y;x.onlineBuyPrice=b;x.supplierUnitPrice=meta.supplierUnitPrice;(state.priceHistory[x.name]||=[]).push({marketPrice:m,yourPrice:y,onlineBuyPrice:b,...meta});},
      recalc:()=>recalcs++,persist:()=>persists++,afterCommit:()=>{},restore:old=>Object.assign(state,old)};
    const first=runAtomicApply(args);
    const second=runAtomicApply({...args,batchId:'auto-2'});
    assert.equal(first.changeCount,4);assert.equal(second.alreadyProcessed,true);assert.equal(p.marketPrice,8.23);assert.equal(p.yourPrice,9.05);
    assert.equal(p.supplierUnitPrice,4.116);assert.equal(p.onlineBuyPrice,49.392);assert.equal(p.pickupBuyPrice,19.4);assert.equal(p.averageCost,3.12);
    assert.equal(persists,1);assert.equal(recalcs,1);assert.equal(state.gameSyncBatches.length,1);
    assert.equal(state.priceHistory[p.name][0].source,'game-auto-sync');assert.equal(state.priceHistory[p.name][0].snapshotId,snapshotId);
  });
  await test('Auto Sync persistence failure rolls back the entire batch', () => {
    const p=tracker(), state={products:[p],priceHistory:{[p.name]:[]}};let live=state;
    const before=JSON.stringify(state), diffs=buildReview([game()],[p]).diffs;
    assert.throws(()=>runAtomicApply({trackerState:state,selected:diffs,batchId:'fail',selectedSave:'slot_0.es3',snapshotFingerprint:'x',snapshotId:'x',mode:'auto',
      update:(x,m,b,y)=>{x.marketPrice=m;x.yourPrice=y;state.priceHistory[x.name].push({batchId:'fail'});},recalc:()=>{},persist:()=>{throw Error('quota');},afterCommit:()=>{},restore:old=>{live=old;}}),/quota/);
    assert.equal(JSON.stringify(live),before);
  });
  await test('undone snapshot is suppressed while a new snapshot can still apply', () => {
    const item=tracker(), oldId='slot_0.es3|old|hash', nextId='slot_0.es3|next|hash';
    const state={products:[item],priceHistory:{[item.name]:[]},
      gameSyncMeta:{lastAutoUndo:{snapshotId:oldId,undoneAt:'2026-09-26T00:00:00Z'},suppressedSnapshotIds:[oldId]}};
    const diffs=buildReview([game()],[item]).diffs;
    let updates=0, persists=0;
    const args={trackerState:state,selected:diffs,batchId:'next-batch',selectedSave:'slot_0.es3',
      snapshotFingerprint:nextId,snapshotId:oldId,mode:'auto',source:'game-auto-sync',
      update:(p,m,b,y)=>{updates++;p.marketPrice=m;p.yourPrice=y;},recalc:()=>{},persist:()=>persists++,
      restore:()=>{throw Error('unexpected rollback');}};
    assert.equal(runAtomicApply(args).alreadyProcessed,true);
    assert.equal(updates,0);assert.equal(persists,0);
    state.gameSyncMeta.suppressedSnapshotIds=[]; // legacy backup: undoneAt still suppresses the same snapshot
    assert.equal(runAtomicApply(args).alreadyProcessed,true);
    const next=runAtomicApply({...args,snapshotId:nextId});
    assert.equal(next.changeCount,4);assert.equal(updates,1);assert.equal(persists,1);
    assert.ok(state.gameSyncMeta.processedSnapshotIds.includes(nextId));
  });
  console.log(`RESULT ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
