/* UI-only localization. Product and category names remain owned by TrackerLocalization. */
(function (root) {
  "use strict";

  const exact = root.TrackerUiMessages?.exact || {};
  const messages = Object.freeze({
    "common.productsCount": { en: "{count} {productWord}", ru: "Товаров: {count}" },
    "common.productNumber": { en: "Product {count}", ru: "Товар {count}" },
    "common.licenseNumber": { en: "License {number}", ru: "Лицензия {number}" },
    "common.licenseShort": { en: "Lic. {number}", ru: "Лиц. {number}" },
    "common.slotNumber": { en: "slot {number}", ru: "слот {number}" },
    "common.visibleCount": { en: "{count} visible", ru: "Показано: {count}" },
    "common.updatesCount": { en: "{count} {updateWord}", ru: "Изменений: {count}" },
    "common.loggedCount": { en: "{count} logged", ru: "Записано: {count}" },
    "common.hiddenVisible": { en: "{hidden} hidden · {visible} visible", ru: "Скрыто: {hidden} · показано: {visible}" },
    "common.coverage": { en: "{percent}% data coverage", ru: "Заполнено данных: {percent}%" },
    "common.pricePerBox": { en: "{price}/box", ru: "{price}/коробка" },
    "common.pricePerItem": { en: "{price}/item", ru: "{price}/шт." },
    "gameSync.productsUpdated": { en: "{count} {productWord} updated", ru: "Обновлено товаров: {count}" },
    "gameSync.existingDifferences": { en: "Initial synchronization required: {count} existing {differenceWord}. Review and apply {differencePronoun} once before Auto Sync starts.", ru: "Нужна начальная синхронизация: найдено отличий — {count}. Проверьте и примените их перед запуском автосинхронизации." },
    "gameSync.changesNeedReview": { en: "Initial synchronization required: {count} {changeWord} {needVerb} review.", ru: "Нужна начальная синхронизация: изменений для проверки — {count}." },
    "gameSync.appliedChanges": { en: "{products} {productWord} · {changes} {changeWord} applied", ru: "Товаров: {products} · применено изменений: {changes}" },
    "gameSync.toast": { en: "Game Sync · {message}", ru: "Синхронизация с игрой · {message}" },
    "gameSync.lastBatch": { en: "{products} {productWord} · {fields} {fieldWord} · {date}", ru: "Товаров: {products} · полей: {fields} · {date}" },
    "gameSync.pendingChanges": { en: "{count} pending {changeWord}. Pickup prices remain in tracker/manual data.", ru: "Ожидает применения изменений: {count}. Цены самовывоза остаются в данных трекера." },
    "gameSync.reviewAll": { en: "Review and apply all {count} {changeWord} once before Auto Sync starts.", ru: "Проверьте и примените все изменения ({count}). После этого начнётся автосинхронизация." },
    "gameSync.changesDetected": { en: "{count} {changeWord} detected.", ru: "Найдено изменений: {count}." },
    "gameSync.reviewSnapshot": { en: "Snapshot: {save}. Only confirmed ProductIDs are selectable.", ru: "Снимок: {save}. Выбрать можно только подтверждённые ProductID." },
    "gameSync.issuesSummary": { en: "Confirmed: {confirmed} · Tracker unmapped: {tracker} · Game without confirmed tracker mapping: {game} · Ambiguous: {ambiguous} · Bakery game-only: {bakery}", ru: "Подтверждено: {confirmed} · без сопоставления в трекере: {tracker} · без подтверждённого соответствия в игре: {game} · неоднозначно: {ambiguous} · только в игре (пекарня): {bakery}" },
    "gameSync.undoActivity": { en: "Undid {products} {productWord} · {changes} {changeWord}", ru: "Отменена синхронизация: товаров — {products}, изменений — {changes}" },
    "product.profitAtThreshold": { en: "Meets minimum profit / box", ru: "Не ниже минимальной прибыли / коробка" },
    "product.profitBelowThreshold": { en: "Below minimum profit / box", ru: "Ниже минимальной прибыли / коробка" },
    "product.profitUnknown": { en: "Profit status unavailable", ru: "Статус прибыли недоступен" },
    "csv.invalidProductIds": { en: "Invalid ProductID in: {ids}", ru: "Некорректный ProductID: {ids}" },
    "csv.noValidRows": { en: "No valid rows found.", ru: "Подходящих строк не найдено." },
    "csv.skippedEmptyCategory": { en: "Skipped rows with empty Category: {count}.", ru: "Пропущено строк без категории: {count}." },
    "csv.duplicatesFound": { en: "Found duplicates: {count}", ru: "Найдено повторов: {count}" },
    "csv.missingPricesImported": { en: "Products imported with missing prices: {count}", ru: "Импортировано товаров без цен: {count}" },
    "csv.missingPricesLoaded": { en: "Products loaded with missing prices: {count}", ru: "Загружено товаров без цен: {count}" },
    "gameSync.pausedReason": { en: "Auto Sync paused: {reason}", ru: "Автосинхронизация приостановлена: {reason}" },
    "gameSync.errorContext": { en: "{context}: {reason}", ru: "{context}: {reason}" },
    "gameSync.productMissing": { en: "Product {name} no longer exists", ru: "Товара {name} больше нет в трекере" },
    "gameSync.laterEdit": { en: "A later tracker edit exists for {name}; Undo was not applied", ru: "После синхронизации товар {name} изменили в трекере; отмена не выполнена" },
    "gameSync.selectTogether": { en: "Product {id}: select Supplier unit price and Online box price together.", ru: "Товар {id}: выберите вместе закупочную цену за штуку и цену Online-коробки." },
    "detail.discount": { en: "Discount: {percent}%", ru: "Скидка: {percent}%" },
    "detail.activeDiscount": { en: "DISCOUNT ACTIVE: -{percent}%", ru: "ДЕЙСТВУЕТ СКИДКА: -{percent}%" },
    "detail.historyCount": { en: "({entries} {entryWord}, {updates} {updateWord})", ru: "(записей: {entries}, изменений: {updates})" },
    "detail.priceVsMarket": { en: "({price} vs market {market})", ru: "({price} при рыночной цене {market})" },
    "detail.noDiscount": { en: "No disc: {price}", ru: "Без скидки: {price}" },
    "detail.baseStockSummary": { en: "{flavourCount} flavour buckets (${flavourCost}) + {coneCount} cone boxes (${coneCost}) = ${total} total", ru: "Ведёрок со вкусами: {flavourCount} (${flavourCost}); коробок рожков: {coneCount} (${coneCost}); всего ${total}" },
    "detail.coneBoxCount": { en: "+{count} cone boxes", ru: "Коробок рожков: +{count}" },
    "detail.scoopCapSummary": { en: "Scoop cap = {scoops} ({bucketCount}×{perBucket}). Cone cap beyond {cap} only matters for 1-scoop orders.", ru: "Предел шариков: {scoops} ({bucketCount}×{perBucket}). Запас рожков сверх {cap} влияет только на заказы с одним шариком." },
    "compare.profitComparison": { en: "Profit comparison - {license}", ru: "Сравнение прибыли — {license}" },
  });

  const sourceText = new WeakMap();
  const sourceAttributes = new WeakMap();
  let started = false;
  let observer = null;

  function locale() {
    return root.TrackerLocalization?.getLocale() === "ru-RU" ? "ru" : "en";
  }

  function interpolate(template, values = {}) {
    return template.replace(/\{([a-zA-Z]+)\}/g, (_, key) => String(values[key] ?? ""));
  }

  function t(key, values = {}) {
    const entry = messages[key];
    if (!entry) return ""; // A missing key must never appear as user text.
    if (locale() === "ru" && entry.ru) return interpolate(entry.ru, values);
    const one = value => Number(value) === 1;
    return interpolate(entry.en, { ...values,
      productWord: one(values.products ?? values.count) ? "product" : "products",
      changeWord: one(values.changes ?? values.count) ? "change" : "changes",
      fieldWord: one(values.fields) ? "field" : "fields",
      differenceWord: one(values.count) ? "difference" : "differences",
      differencePronoun: one(values.count) ? "it" : "them",
      needVerb: one(values.count) ? "needs" : "need",
      entryWord: one(values.entries) ? "entry" : "entries",
      updateWord: one(values.updates) ? "update" : "updates",
    });
  }

  function dynamic(source) {
    let match;
    if ((match = /^(\d+) products updated$/.exec(source))) return t("gameSync.productsUpdated", { count: match[1] });
    if ((match = /^(\d+) products$/.exec(source))) return t("common.productsCount", { count: match[1] });
    if ((match = /^(\d+) updates?$/.exec(source))) return t("common.updatesCount", { count: match[1], updates: match[1] });
    if ((match = /^(\d+) logged$/.exec(source))) return t("common.loggedCount", { count: match[1] });
    if ((match = /^Product (\d+)$/.exec(source))) return t("common.productNumber", { count: match[1] });
    if ((match = /^Profit comparison - (.+)$/.exec(source))) return t("compare.profitComparison", { license: translate(match[1]) });
    if ((match = /^License (\d+)$/.exec(source))) return t("common.licenseNumber", { number: match[1] });
    if ((match = /^Lic\.\s*(\d+)$/.exec(source))) return t("common.licenseShort", { number: match[1] });
    if ((match = /^Tracker (\d+)$/.exec(source))) return locale() === "ru" ? `Трекер ${match[1]}` : source;
    if ((match = /^slot (\d+)$/.exec(source))) return t("common.slotNumber", { number: match[1] });
    if ((match = /^(\d+) visible$/.exec(source))) return t("common.visibleCount", { count: match[1] });
    if ((match = /^(\d+) hidden · (\d+) visible$/.exec(source)))
      return t("common.hiddenVisible", { hidden: match[1], visible: match[2] });
    if ((match = /^(\d+)% data coverage$/.exec(source))) return t("common.coverage", { percent: match[1] });
    if ((match = /^(\$[\d.,]+)\/box$/.exec(source))) return t("common.pricePerBox", { price: match[1] });
    if ((match = /^(\$[\d.,]+)\/item$/.exec(source))) return t("common.pricePerItem", { price: match[1] });
    if ((match = /^Initial synchronization required: (\d+) existing differences\. Review and apply them once before Auto Sync starts\.$/.exec(source)))
      return t("gameSync.existingDifferences", { count: match[1] });
    if ((match = /^Initial synchronization required: (\d+) changes need review\.$/.exec(source)))
      return t("gameSync.changesNeedReview", { count: match[1] });
    if ((match = /^(\d+) products · (\d+) changes applied$/.exec(source)))
      return t("gameSync.appliedChanges", { products: match[1], changes: match[2] });
    if ((match = /^(\d+) products · (\d+) fields · (.+)$/.exec(source)))
      return t("gameSync.lastBatch", { products: match[1], fields: match[2], date: match[3] });
    if ((match = /^(\d+) pending changes\. Pickup prices remain in tracker\/manual data\.$/.exec(source)))
      return t("gameSync.pendingChanges", { count: match[1] });
    if ((match = /^Undid (\d+) products · (\d+) changes$/.exec(source)))
      return t("gameSync.undoActivity", { products: match[1], changes: match[2] });
    if ((match = /^Auto Sync paused: (.+)$/.exec(source)))
      return t("gameSync.pausedReason", { reason: translate(match[1]) });
    if ((match = /^Discount: (\d+)%$/.exec(source)))
      return t("detail.discount", { percent: match[1] });
    if ((match = /^DISCOUNT ACTIVE: -(\d+)%$/.exec(source)))
      return t("detail.activeDiscount", { percent: match[1] });
    if ((match = /^\((\d+) entries, (\d+) updates\)$/.exec(source)))
      return t("detail.historyCount", { entries: match[1], updates: match[2] });
    if ((match = /^\((\$[\d.,]+) vs market (\$[\d.,]+)\)$/.exec(source)))
      return t("detail.priceVsMarket", { price: match[1], market: match[2] });
    if ((match = /^No disc: (\$[\d.,]+)$/.exec(source)))
      return t("detail.noDiscount", { price: match[1] });
    if ((match = /^Product (.+) no longer exists$/.exec(source)))
      return t("gameSync.productMissing", { name: match[1] });
    if ((match = /^A later tracker edit exists for (.+); Undo was not applied$/.exec(source)))
      return t("gameSync.laterEdit", { name: match[1] });
    if ((match = /^Product (\d+): select Supplier unit price and Online box price together\.$/.exec(source)))
      return t("gameSync.selectTogether", { id: match[1] });
    if ((match = /^(Undo failed|Batch was rolled back|Could not persist baseline requirement|Could not persist initial baseline|Snapshot or baseline validation failed|Could not persist the game version check|Could not record snapshot identity): (.+)$/.exec(source)))
      return t("gameSync.errorContext", { context: translate(match[1]), reason: translate(match[2]) });
    if ((match = /^Game Sync · (.+)$/.exec(source)))
      return t("gameSync.toast", { message: translate(match[1]) });
    return null;
  }

  function translate(source) {
    if (typeof source !== "string") return source;
    const lead = /^\s*/.exec(source)[0], tail = /\s*$/.exec(source)[0];
    const core = source.trim().replace(/\s+/g, " ");
    if (!core) return source;
    if (locale() !== "ru") {
      const corrected = dynamic(core);
      return corrected ? lead + corrected + tail : source;
    }
    if (exact[core]) return lead + exact[core] + tail;
    if (/^DLC-[A-Za-z]+-\d+$/.test(core)) return source;
    if (/^Lic\.\s*DLC-[A-Za-z]/.test(core)) return lead + "Лиц. " + core.replace(/^Lic\.\s*/, "") + tail;
    const translated = dynamic(core);
    return translated ? lead + translated + tail : source; // English fallback.
  }

  function textNode(node) {
    if (node.parentElement?.closest("script,style,textarea,[contenteditable=true]")) return;
    const current = node.nodeValue;
    const previous = sourceText.get(node);
    const original = previous && (current === previous.localized || current === previous.original)
      ? previous.original : current;
    const localized = translate(original);
    sourceText.set(node, { original, localized });
    if (current !== localized) node.nodeValue = localized;
  }

  function attributes(element) {
    if (element.tagName === "SCRIPT" || element.tagName === "STYLE") return;
    let remembered = sourceAttributes.get(element);
    if (!remembered) { remembered = new Map(); sourceAttributes.set(element, remembered); }
    for (const name of ["title", "placeholder", "aria-label"]) {
      if (!element.hasAttribute(name)) continue;
      const current = element.getAttribute(name);
      const previous = remembered.get(name);
      const original = previous && (current === previous.localized || current === previous.original)
        ? previous.original : current;
      const localized = translate(original);
      remembered.set(name, { original, localized });
      if (current !== localized) element.setAttribute(name, localized);
    }
  }

  function localizeTree(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) { textNode(rootNode); return; }
    if (rootNode.nodeType !== 1 && rootNode.nodeType !== 9) return;
    if (rootNode.nodeType === 1) attributes(rootNode);
    const walker = root.document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeType === 3) textNode(node);
      else attributes(node);
    }
  }

  function refresh() {
    root.document.documentElement.lang = locale() === "ru" ? "ru" : "en";
    localizeTree(root.document.documentElement);
  }

  function start() {
    if (started || !root.document?.documentElement) return;
    started = true;
    const nativeAlert = root.alert, nativeConfirm = root.confirm, nativePrompt = root.prompt;
    if (typeof nativeAlert === "function") root.alert = message => nativeAlert.call(root, translate(String(message)));
    if (typeof nativeConfirm === "function") root.confirm = message => nativeConfirm.call(root, translate(String(message)));
    if (typeof nativePrompt === "function") root.prompt = (message, defaultValue) => nativePrompt.call(root, translate(String(message)), defaultValue);
    root.addEventListener("tracker-localization-changed", refresh);
    observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "characterData") textNode(record.target);
        else if (record.type === "attributes") attributes(record.target);
        else for (const node of record.addedNodes) localizeTree(node);
      }
    });
    observer.observe(root.document.documentElement, { subtree: true, childList: true,
      characterData: true, attributes: true, attributeFilter: ["title", "placeholder", "aria-label"] });
    refresh();
  }

  root.UiLocalization = Object.freeze({ t, translate, refresh, start,
    getLocale: locale, messages, exact });
})(window);
