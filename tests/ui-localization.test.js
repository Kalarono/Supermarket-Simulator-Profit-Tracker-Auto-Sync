const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const base = path.join(__dirname, '..');
let locale = 'en';
const window = { TrackerLocalization: { getLocale: () => locale } };
const context = vm.createContext({ window, NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 } });
for (const file of ['src/ui-messages.js', 'src/ui-localization.js'])
  vm.runInContext(fs.readFileSync(path.join(base, file), 'utf8'), context, { filename: file });
const ui = window.UiLocalization;

function check(name, fn) { fn(); console.log('PASS', name); }

check('English and Russian resolve from the same UI layer without reload', () => {
  assert.equal(ui.translate('Review Changes'), 'Review Changes');
  assert.equal(ui.t('gameSync.productsUpdated', { count: 13 }), '13 products updated');
  assert.equal(ui.t('gameSync.productsUpdated', { count: 1 }), '1 product updated');
  assert.equal(ui.t('detail.historyCount', { entries: 1, updates: 0 }), '(1 entry, 0 updates)');
  assert.equal(ui.translate('1 products'), '1 product');
  locale = 'ru-RU';
  assert.equal(ui.translate('Review Changes'), 'Проверить изменения');
  assert.equal(ui.t('gameSync.productsUpdated', { count: 13 }), 'Обновлено товаров: 13');
  locale = 'en';
  assert.equal(ui.translate('Review Changes'), 'Review Changes');
});

check('counts, license labels, and raw identifiers localize correctly', () => {
  locale = 'ru-RU';
  assert.equal(ui.translate('13 products updated'), 'Обновлено товаров: 13');
  assert.equal(ui.translate('Product 12'), 'Товар 12');
  assert.equal(ui.translate('License 12'), 'Лицензия 12');
  assert.equal(ui.translate('DLC-Bakery-1'), 'DLC-Bakery-1');
  assert.equal(ui.translate('DLC-IceCream-1 · License 1 · Store Lv6'), 'DLC-IceCream-1 · лицензия 1 · магазин, уровень 6');
  assert.equal(ui.translate('Lic.DLC-Bakery-1'), 'Лиц. DLC-Bakery-1');
  assert.equal(ui.t('csv.skippedEmptyCategory', { count: 1 }), 'Пропущено строк без категории: 1.');
  assert.equal(ui.t('csv.skippedEmptyCategory', { count: 5 }), 'Пропущено строк без категории: 5.');
  assert.equal(ui.t('detail.historyCount', { entries: 1, updates: 0 }), '(записей: 1, изменений: 0)');
  assert.equal(ui.t('detail.discount', { percent: 15 }), 'Скидка: 15%');
  assert.equal(ui.translate('Pickup'), 'Самовывоз');
  assert.equal(ui.translate('helper-connected'), 'помощник подключён');
  assert.equal(ui.translate('helper-disconnected'), 'помощник отключён');
  assert.equal(ui.translate('baseline-required'), 'требуется начальная синхронизация');
  assert.equal(ui.translate('paused'), 'приостановлено');
  assert.equal(ui.translate('No market type'), 'Без типа магазина');
  assert.equal(ui.translate('Essentials'), 'Товары первой необходимости');
  assert.equal(ui.translate('Online profit/box'), 'Прибыль онлайн / коробка');
  assert.equal(ui.translate('Price updates'), 'Изменения цены');
  assert.equal(ui.translate('1 update'), 'Изменений: 1');
  assert.equal(ui.translate('12 updates'), 'Изменений: 12');
  assert.equal(ui.translate('0 logged'), 'Записано: 0');
  assert.equal(ui.translate('Profit comparison - License 7'), 'Сравнение прибыли — Лицензия 7');
  assert.equal(ui.translate('Lic. DLC-Essentials-5'), 'Лиц. DLC-Essentials-5');
});

check('missing Russian translation falls back to English, never to a key', () => {
  locale = 'ru-RU';
  assert.equal(ui.translate('Unsupported sample text'), 'Unsupported sample text');
  assert.equal(ui.t('nonexistent.key'), '');
  assert.ok(!ui.translate('Unsupported sample text').includes('nonexistent.key'));
});

check('language and profit threshold are in full backup and restore', () => {
  const html = fs.readFileSync(path.join(base, 'supermarketSimulator-tracker_v2_9.html'), 'utf8');
  assert.match(html, /displayLocale:\s*window\.TrackerLocalization\?\.getLocale\(\)/);
  assert.match(html, /backup\.displayLocale/);
  assert.match(html, /minimumProfitPerBox/);
  assert.match(html, /ProfitThreshold\.fromBackup\(backup\.minimumProfitPerBox\)/);
  assert.match(html, /if \(s\.displayLocale === "en" \|\| s\.displayLocale === "ru-RU"\)/);
});

check('initial audit strings all have Russian translations or are canonical labels', () => {
  const audit = JSON.parse(fs.readFileSync(path.join(base, 'tests/fixtures/ui-audit-candidates.json'), 'utf8'));
  const intentional = value => /^L\d+$/.test(value) || value === 'English' || value === 'v2.9' || value === '/health: HTTP 404';
  const missing = audit.filter(value => !intentional(value) && ui.translate(value) === value);
  assert.deepEqual(missing, []);
});
