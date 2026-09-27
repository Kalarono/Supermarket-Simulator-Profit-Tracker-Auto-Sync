const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runAtomicApply } = require('../src/game-sync.js');
const ProfitThreshold = require('../src/profit-threshold.js');

function product(yourPrice, overrides = {}) {
  return { name: 'Test product', productId: 1, yourPrice, onlineBuyPrice: 10,
    items: 10, gamePurchaseQuantity: null, isWeight: false, ...overrides };
}
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function test(name, callback) {
  callback();
  console.log('PASS', name);
}

test('30.00 is green and 29.99 is red', () => {
  assert.equal(ProfitThreshold.status(product(4), 30, true), 'green');
  assert.equal(ProfitThreshold.status(product(3.999), 30, true), 'red');
});

test('raw precision wins over the rounded display', () => {
  const p = product(3.9996);
  assert.equal(ProfitThreshold.rawProfit(p).toFixed(2), '30.00');
  assert.equal(ProfitThreshold.status(p, 30, true), 'red');
  assert.equal(ProfitThreshold.status(product(4.0004), 30, true), 'green');
  assert.equal(ProfitThreshold.status(product(4.4), 30, true, 10), 'red');
});

test('missing inputs are unknown and an inactive product keeps its own status', () => {
  assert.equal(ProfitThreshold.status(product(4, { onlineBuyPrice: null }), 30, true), 'unknown');
  assert.equal(ProfitThreshold.status(product(4, { items: null }), 30, true), 'unknown');
  assert.equal(ProfitThreshold.status(product(3), 30, false), 'inactive');
});

test('active-only, below-only, and combined filters', () => {
  const rows = [
    { p: product(4), activeStatus: true },
    { p: product(3), activeStatus: true },
    { p: product(3, { productId: 2 }), activeStatus: false },
    { p: product(3, { productId: 3 }), activeStatus: null },
    { p: product(null, { productId: 4 }), activeStatus: true },
  ];
  const select = (options) => rows.filter(({ p, activeStatus }) =>
    ProfitThreshold.matches(p, { threshold: 30, activeStatus, ...options }));
  assert.equal(select({ activeOnly: true }).length, 3);
  assert.equal(select({ belowOnly: true }).length, 3);
  assert.equal(select({ activeOnly: true, belowOnly: true }).length, 1);
});

test('threshold survives reload and JSON backup/restore, including old backups', () => {
  const original = storage();
  assert.equal(ProfitThreshold.load(original), 30);
  ProfitThreshold.save(original, 42.125);
  assert.equal(ProfitThreshold.load(original), 42.125);
  const backup = JSON.parse(JSON.stringify({ minimumProfitPerBox: ProfitThreshold.load(original) }));
  const restored = storage();
  ProfitThreshold.save(restored, ProfitThreshold.fromBackup(backup.minimumProfitPerBox));
  assert.equal(ProfitThreshold.load(restored), 42.125);
  ProfitThreshold.save(restored, ProfitThreshold.fromBackup({}.minimumProfitPerBox));
  assert.equal(ProfitThreshold.load(restored), 30);
  const html = fs.readFileSync(path.join(__dirname, '../supermarketSimulator-tracker_v2_9.html'), 'utf8');
  assert.match(html, /minimumProfitPerBox,\s*widgetVisibility:/);
  assert.match(html, /ProfitThreshold\.fromBackup\(backup\.minimumProfitPerBox\)/);
});

test('Auto Sync commit is reflected by the next profitability evaluation', () => {
  const p = product(4);
  const state = { products: [p], priceHistory: { [p.name]: [] }, gameSyncMeta: { processedSnapshotIds: [] } };
  assert.equal(ProfitThreshold.status(p, 30, true), 'green');
  const result = runAtomicApply({
    trackerState: state, selected: [{ productId: 1, trackerName: p.name, field: 'yourPrice',
      to: 3, mappingStatus: 'confirmed' }], batchId: 'threshold-auto-1',
    selectedSave: 'slot_0.es3', snapshotFingerprint: 'threshold-auto-1',
    snapshotId: 'threshold-auto-1', mode: 'auto', source: 'game-auto-sync',
    undoRecord: { batchId: 'threshold-auto-1', products: [] },
    update: (current, _market, _buy, sell) => { current.yourPrice = sell; },
    recalc: () => {}, persist: () => {}, afterCommit: () => {},
    restore: old => Object.assign(state, old),
  });
  assert.equal(result.changeCount, 1);
  assert.equal(ProfitThreshold.status(p, 30, true), 'red');
});
