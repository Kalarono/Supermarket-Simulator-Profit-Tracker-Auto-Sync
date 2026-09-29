/* Optional game-localization presentation layer. Canonical product/history keys stay untouched. */
(function (root) {
  "use strict";

  const PREF_KEY = "smtracker_displayLocale";
  const API_URL = root.location?.protocol === "http:" && root.location?.hostname === "127.0.0.1"
    ? root.location.origin : "http://127.0.0.1:47831";
  const VALID_LOCALES = new Set(["en", "ru-RU"]);
  let locale = readPreference();
  let available = ["en"];
  let products = Object.create(null);
  let warning = "";
  let isCurrent = false;
  let requestId = 0;
  let bundleFingerprint = null;
  let hasRussianData = false;
  let refreshTimer = null;

  function readPreference() {
    try {
      const saved = root.localStorage?.getItem(PREF_KEY);
      return VALID_LOCALES.has(saved) ? saved : "en";
    } catch { return "en"; }
  }

  async function get(path) {
    if (!root.fetch) throw new Error("Fetch is unavailable");
    const controller = new AbortController();
    const timer = root.setTimeout(() => controller.abort(), 1800);
    try {
      const response = await root.fetch(API_URL + path, {
        method: "GET", mode: "cors", cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return await response.json();
    } finally { root.clearTimeout(timer); }
  }

  function notify() {
    root.dispatchEvent(new CustomEvent("tracker-localization-changed", {
      detail: { locale, available: [...available], warning, isCurrent },
    }));
  }

  async function refresh() {
    const id = ++requestId;
    let nextProducts = products;
    let nextHasRussianData = hasRussianData;
    let nextAvailable = ["en"];
    let nextWarning = "";
    let nextIsCurrent = false;
    let nextFingerprint = null;
    try {
      const locales = await get("/locales");
      if (locales?.schemaVersion !== 1 || !Array.isArray(locales.available))
        throw new Error("/locales: malformed response");
      if (id !== requestId) return;
      nextAvailable = locales.available.filter(value => VALID_LOCALES.has(value));
      if (!nextAvailable.includes("en")) nextAvailable.unshift("en");
      nextWarning = typeof locales.warning === "string" ? locales.warning : "";
      nextIsCurrent = locales.isCurrent === true;
      nextFingerprint = typeof locales.bundleFingerprint === "string" ? locales.bundleFingerprint : null;
      if (nextFingerprint !== bundleFingerprint) {
        nextProducts = Object.create(null);
        nextHasRussianData = false;
      }
      if (locale === "ru-RU" && nextAvailable.includes("ru-RU") && !nextHasRussianData) {
        const payload = await get("/localization/ru-RU");
        if (payload?.schemaVersion !== 1 || payload.locale !== "ru-RU" ||
            payload.available !== true || !payload.products || typeof payload.products !== "object")
          throw new Error(payload?.warning || "/localization/ru-RU: unavailable");
        if (nextFingerprint && payload.bundleFingerprint !== nextFingerprint)
          throw new Error("Localization fingerprint changed during load; retrying shortly");
        if (id !== requestId) return;
        nextProducts = payload.products;
        nextHasRussianData = true;
        nextWarning = typeof payload.warning === "string" ? payload.warning : nextWarning;
      } else if (locale === "ru-RU" && !nextAvailable.includes("ru-RU")) {
        nextProducts = Object.create(null);
        nextHasRussianData = false;
      }
      if (id !== requestId) return;
      products = nextProducts;
      hasRussianData = nextHasRussianData;
      available = nextAvailable;
      warning = nextWarning;
      isCurrent = nextIsCurrent;
      bundleFingerprint = nextFingerprint;
    } catch (error) {
      if (id !== requestId) return;
      // Keep the last complete localization while the helper is temporarily offline.
      // A later poll retries the API; transient failures must not blank Russian names.
      warning = error?.message || "Official game localization is unavailable";
    }
    if (id === requestId) notify();
  }

  function setLocale(next) {
    locale = VALID_LOCALES.has(next) ? next : "en";
    try { root.localStorage?.setItem(PREF_KEY, locale); } catch { /* tracker remains usable */ }
    const picker = root.document?.getElementById("displayLanguage");
    if (picker) picker.value = locale;
    notify();
    return refresh();
  }

  function getProduct(product) {
    if (locale !== "ru-RU" || !product || !Number.isSafeInteger(product.productId)) return null;
    return products[String(product.productId)] || null;
  }

  function start() {
    const picker = root.document?.getElementById("displayLanguage");
    if (picker) picker.value = locale;
    if (root.setInterval && refreshTimer === null)
      refreshTimer = root.setInterval(() => { void refresh(); }, 30000);
    void refresh();
  }

  root.TrackerLocalization = Object.freeze({
    start, refresh, setLocale, getLocale: () => locale,
    getAvailableLocales: () => [...available], getWarning: () => warning,
    getProduct, preferenceKey: PREF_KEY,
  });
})(window);
