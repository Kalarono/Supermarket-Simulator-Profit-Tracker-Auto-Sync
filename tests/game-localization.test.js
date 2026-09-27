const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../src/game-localization.js'), 'utf8');
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error); }
}

function createClient() {
  const stored = new Map();
  const events = [];
  let offline = false;
  let fingerprint = 'sha256:fixture-v1';
  let russianLabel = 'Хлопья';
  let intervalCallback = null;
  let intervalMs = null;
  let localizationFetches = 0;
  const russian = {
    schemaVersion: 1, locale: 'ru-RU', available: true, warning: null,
    products: { '33': { productId: 33, canonicalCategory: 'Cereal', canonicalBrand: 'Chokipik',
      localizedCategory: 'Хлопья', localizedLabel: 'Хлопья', displayName: 'Хлопья - Chokipik' } },
  };
  const window = {
    location: { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:47831' },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    document: { getElementById: () => null },
    setTimeout, clearTimeout,
    setInterval: (callback, ms) => { intervalCallback = callback; intervalMs = ms; return 1; },
    dispatchEvent: event => { events.push(event); },
    fetch: async url => {
      if (offline) throw new Error('offline fixture');
      if (url.endsWith('/locales')) return { ok: true, json: async () => ({ schemaVersion: 1, available: ['en', 'ru-RU'], detected: ['en', 'ru-RU'], bundleFingerprint: fingerprint, warning: null }) };
      if (url.endsWith('/localization/ru-RU')) {
        localizationFetches++;
        return { ok: true, json: async () => ({ ...russian, bundleFingerprint: fingerprint,
          products: { '33': { ...russian.products['33'], localizedLabel: russianLabel, displayName: `${russianLabel} - Chokipik` } } }) };
      }
      throw new Error('unexpected URL ' + url);
    },
  };
  class TestCustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
  const context = vm.createContext({ window, CustomEvent: TestCustomEvent, AbortController, Number, Object, Set });
  vm.runInContext(source, context, { filename: 'game-localization.js' });
  return { api: window.TrackerLocalization, stored, events,
    setOffline: value => { offline = value; },
    setCatalog: (nextFingerprint, nextLabel) => { fingerprint = nextFingerprint; russianLabel = nextLabel; },
    poll: () => intervalCallback?.(), getIntervalMs: () => intervalMs,
    getLocalizationFetches: () => localizationFetches };
}

(async () => {
  await check('official Russian label loads by stable ProductID and keeps canonical rows unmapped', async () => {
    const client = createClient();
    await client.api.setLocale('ru-RU');
    await client.api.refresh();
    assert.equal(client.api.getLocale(), 'ru-RU');
    assert.equal(client.api.getProduct({ productId: 33 })?.localizedLabel, 'Хлопья');
    assert.equal(client.api.getProduct({ productId: 33 })?.displayName, 'Хлопья - Chokipik');
    assert.equal(client.api.getProduct({ productId: null }), null);
    assert.equal(client.stored.get('smtracker_displayLocale'), 'ru-RU');
  });
  await check('offline helper falls back to English and clears localized labels', async () => {
    const client = createClient();
    client.api.setLocale('ru-RU');
    client.setOffline(true);
    await client.api.refresh();
    assert.deepEqual(Array.from(client.api.getAvailableLocales()), ['en']);
    assert.equal(client.api.getProduct({ productId: 33 }), null);
    assert.match(client.api.getWarning(), /offline fixture/);
  });
  await check('background fingerprint poll refreshes changed game strings without repeated bundle downloads', async () => {
    const client = createClient();
    client.api.start();
    await client.api.refresh();
    await client.api.setLocale('ru-RU');
    const downloadsBefore = client.getLocalizationFetches();
    client.api.start();
    assert.equal(client.getIntervalMs(), 30000);
    client.setCatalog('sha256:fixture-v2', 'Крупа');
    client.poll();
    for (let i = 0; i < 10 && client.api.getProduct({ productId: 33 })?.localizedLabel !== 'Крупа'; i++)
      await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(client.api.getProduct({ productId: 33 })?.displayName, 'Крупа - Chokipik');
    assert.equal(client.getLocalizationFetches(), downloadsBefore + 1);
  });
  await check('invalid preference is constrained to English and state update emits a change event', async () => {
    const client = createClient();
    await client.api.setLocale('es-ES');
    assert.equal(client.api.getLocale(), 'en');
    assert.equal(client.stored.get('smtracker_displayLocale'), 'en');
    assert.ok(client.events.some(event => event.type === 'tracker-localization-changed'));
  });
  console.log(`RESULT ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
