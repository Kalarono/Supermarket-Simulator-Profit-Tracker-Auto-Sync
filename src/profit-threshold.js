/* Products-only presentation and filtering for new Online purchase profit per box. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ProfitThreshold = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const DEFAULT = 30;
  const STORAGE_KEY = "smtracker_minProfitPerBox";

  function validThreshold(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  function fromBackup(value) {
    return validThreshold(value) ? value : DEFAULT;
  }

  function load(storage) {
    try {
      const value = JSON.parse(storage.getItem(STORAGE_KEY));
      return fromBackup(value);
    } catch { return DEFAULT; }
  }

  function save(storage, value) {
    if (!validThreshold(value)) throw new RangeError("Minimum profit per box must be a nonnegative number");
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
    return value;
  }

  function rawProfit(product, discountPct = 0) {
    if (!product || !Number.isFinite(product.yourPrice) || !Number.isFinite(product.onlineBuyPrice) ||
        !Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) return null;
    const units = product.gamePurchaseQuantity || (product.isWeight ? product.weight : product.items);
    if (!Number.isFinite(units) || units <= 0) return null;
    const profit = product.yourPrice * (1 - discountPct / 100) * units - product.onlineBuyPrice;
    return Number.isFinite(profit) ? profit : null;
  }

  function status(product, threshold, activeStatus, discountPct = 0) {
    if (activeStatus === false) return "inactive";
    const profit = rawProfit(product, discountPct);
    if (profit === null || !validThreshold(threshold)) return "unknown";
    return profit >= threshold ? "green" : "red";
  }

  function matches(product, { activeOnly = false, belowOnly = false, threshold = DEFAULT,
    activeStatus = null, discountPct = 0 } = {}) {
    if (activeOnly && activeStatus !== true) return false;
    if (belowOnly) {
      const profit = rawProfit(product, discountPct);
      if (profit === null || profit >= threshold) return false;
    }
    return true;
  }

  return Object.freeze({ DEFAULT, STORAGE_KEY, fromBackup, load, save, rawProfit, status, matches });
});
