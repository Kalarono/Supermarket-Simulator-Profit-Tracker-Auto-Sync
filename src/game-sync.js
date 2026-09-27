/* Optional Game Sync adapter. The original tracker continues to run if this file is absent. */
(function (root) {
  "use strict";
  const API_URL = root.location?.protocol === "http:" && root.location?.hostname === "127.0.0.1"
    ? root.location.origin : "http://127.0.0.1:47831";
  const SCHEMA_VERSION = 3;
  const PRICE_SEMANTICS_VERSION = 3;
  const TRACKER_VERSION = "2.9";
  const PREFS_KEY = "smtracker_gameSync_v1";
  const AUTO_CONSENT_KEY = "smtracker_gameSync_autoConsent_v1";
  const PRICE_EPSILON = 0.000001; // raw JS numbers; UI may display fewer decimals
  const AUTO_SYNC_THRESHOLDS = Object.freeze({ maxChangedProductRatio: 0.25, maxProducts: 10000 });
  const TRUSTED_MAPPINGS = new Set(["confirmed-exact", "confirmed-alias", "confirmed-metadata"]);
  const AUTO_SYNC_FIELDS = new Set(["supplierUnitPrice", "onlineBuyPrice", "averageCost", "marketPrice", "yourPrice"]);
  const priceLabel = en => root.UiLocalization?.translate(en) || en;
  const uiT = (key, values) => root.UiLocalization?.t(key, values) || "";
  const uiText = value => root.UiLocalization?.translate(value) || value;
  const localizedProduct = (productId, fallback, field = "displayName") =>
    root.TrackerLocalization?.getProduct({ productId })?.[field] || fallback;
  function refreshLocalizedGameCells() {
    root.document?.querySelectorAll("[data-game-localized]").forEach(cell => {
      const id = Number(cell.dataset.gameProductId);
      cell.textContent = localizedProduct(id, cell.dataset.gameFallback || "",
        cell.dataset.gameLocalized === "category" ? "localizedCategory" : "displayName");
    });
  }
  root.addEventListener?.("tracker-localization-changed", () => {
    refreshLocalizedGameCells();
    Promise.resolve().then(() => {
      const doc = root.document;
      if (doc?.getElementById("gameSyncReviewModal")?.classList.contains("open")) {
        const selected = new Set(Array.from(doc.querySelectorAll("#gameSyncReviewModal .game-sync-diff:checked"), box => box.dataset.key));
        openReview();
        doc.querySelectorAll("#gameSyncReviewModal .game-sync-diff").forEach(box => { box.checked = selected.has(box.dataset.key); });
      }
      if (doc?.getElementById("gameSyncIssuesModal")?.classList.contains("open")) openIssues();
      if (doc?.getElementById("gameSyncActivityModal")?.classList.contains("open")) openActivity();
      if (doc?.getElementById("gameSyncAutoConfirmModal")?.classList.contains("open")) showAutoSyncConfirmation();
    });
  });

  class ApiSchemaError extends Error {}
  class ApiResponseError extends Error {}
  class GameSyncClient {
    constructor(baseUrl = API_URL, timeoutMs = 2500, fetchImpl = root.fetch?.bind(root)) {
      this.baseUrl = baseUrl;
      this.timeoutMs = timeoutMs;
      this.fetchImpl = fetchImpl;
      this.cachedIdentity = null;
      this.cachedSnapshot = null;
      this.rejectedSnapshot = null;
    }
    async get(path) {
      if (!this.fetchImpl) throw new TypeError("Fetch unavailable");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.baseUrl + path,
          { method: "GET", mode: "cors", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new ApiResponseError(`${path}: HTTP ${response.status}`);
        try { return await response.json(); }
        catch { throw new ApiResponseError(`${path}: invalid JSON`); }
      } finally { clearTimeout(timer); }
    }
    async check() {
      const health = await this.get("/health");
      requireSchema(health, "/health");
      if (health.status !== "ok") throw new ApiResponseError("Helper health is not ok");
      const status = await this.get("/status");
      validateStatus(status);
      if (!status.connected) return { status, products: null, licenses: null };
      const identity = snapshotIdentity(status);
      if (this.rejectedSnapshot?.identity === identity)
        throw new this.rejectedSnapshot.Error(this.rejectedSnapshot.message);
      const unchanged = this.cachedIdentity === identity && !!this.cachedSnapshot;
      let snapshot;
      if (unchanged) snapshot = this.cachedSnapshot;
      else {
        try {
          snapshot = await this.get("/snapshot");
          requireSchema(snapshot, "/snapshot");
          if (snapshot.snapshotHash !== status.snapshotHash || snapshot.sourceSave !== status.selectedSave ||
              snapshot.products?.length !== status.productCount ||
              Date.parse(snapshot.saveWriteTimeUtc) !== Date.parse(status.lastSaveWriteTime))
            throw new ApiResponseError("Snapshot changed while the helper response was being read");
          const data = { schemaVersion: snapshot.schemaVersion, products: snapshot.products };
          const licenses = { schemaVersion: snapshot.schemaVersion, unlockedLicenses: snapshot.unlockedLicenses,
            activeLicenses: snapshot.activeLicenses };
          validateProducts(data, status);
          validateLicenses(licenses);
          this.cachedIdentity = identity;
          this.cachedSnapshot = snapshot;
          this.rejectedSnapshot = null;
        } catch (error) {
          if (error instanceof ApiResponseError || error instanceof ApiSchemaError)
            this.rejectedSnapshot = { identity, Error: error.constructor, message: error.message };
          throw error;
        }
      }
      const licenses = { schemaVersion: snapshot.schemaVersion, unlockedLicenses: snapshot.unlockedLicenses,
        activeLicenses: snapshot.activeLicenses };
      return { status, products: snapshot.products, licenses, snapshot,
        unchanged };
    }
  }

  function requireSchema(value, path) {
    if (!value || typeof value !== "object" || value.schemaVersion !== SCHEMA_VERSION)
      throw new ApiSchemaError(`${path}: API schemaVersion must be ${SCHEMA_VERSION}`);
  }
  function validField(field, productId, name, sourcePrefix) {
    if (!field || typeof field !== "object" || !["present", "absent", "invalid"].includes(field.status))
      throw new ApiResponseError(`Product ${productId}: malformed ${name}`);
    if (field.status === "present") {
      if (typeof field.value !== "number" || !Number.isFinite(field.value) || field.value < 0 ||
          typeof field.source !== "string" ||
          !field.source.startsWith(sourcePrefix.replace("{id}", String(productId))))
        throw new ApiResponseError(`Product ${productId}: invalid value/source for ${name}`);
    } else if (field.value !== null) {
      throw new ApiResponseError(`Product ${productId}: non-null absent/invalid ${name}`);
    }
  }
  function validBooleanField(field, productId, name, source) {
    if (!field || typeof field !== "object" || !["present", "absent", "invalid"].includes(field.status))
      throw new ApiResponseError(`Product ${productId}: malformed ${name}`);
    if (field.status === "present") {
      if (typeof field.value !== "boolean" || field.source !== source)
        throw new ApiResponseError(`Product ${productId}: invalid value/source for ${name}`);
    } else if (field.value !== null || field.source !== null) {
      throw new ApiResponseError(`Product ${productId}: non-null absent/invalid ${name}`);
    }
  }
  function validateStatus(status) {
    requireSchema(status, "/status");
    if (typeof status.connected !== "boolean" || typeof status.productCount !== "number" ||
        !Number.isSafeInteger(status.productCount) || status.productCount < 0 ||
        (status.selectedSave !== null && typeof status.selectedSave !== "string"))
      throw new ApiResponseError("Malformed /status");
    if (status.warnings != null && (!Array.isArray(status.warnings) || status.warnings.some(w => typeof w !== "string")))
      throw new ApiResponseError("Malformed /status warnings");
    if (status.connected && (!status.selectedSave || !status.lastSaveWriteTime ||
        !Number.isFinite(Date.parse(status.lastSaveWriteTime)) ||
        !Number.isFinite(Date.parse(status.lastSuccessfulParse)) || !/^[a-f0-9]{64}$/i.test(status.snapshotHash || "")))
      throw new ApiResponseError("Connected status has no valid save identity");
  }
  function snapshotIdentity(status) {
    return `${status.selectedSave}|${status.lastSaveWriteTime}|${status.snapshotHash}`;
  }
  function processedSnapshotIds(meta) {
    return Array.isArray(meta?.processedSnapshotIds) ? [...new Set(meta.processedSnapshotIds.filter(id => typeof id === "string"))] : [];
  }
  function suppressedSnapshotIds(meta) {
    return Array.isArray(meta?.suppressedSnapshotIds) ? [...new Set(meta.suppressedSnapshotIds.filter(id => typeof id === "string"))] : [];
  }
  function isSuppressedSnapshot(meta, snapshotId) {
    return suppressedSnapshotIds(meta).includes(snapshotId) ||
      (meta?.lastAutoUndo?.undoneAt && meta.lastAutoUndo.snapshotId === snapshotId);
  }
  function validateAutoSyncSnapshot(status, snapshot, now = Date.now()) {
    if (!status?.connected || !snapshot || status.error ||
        !/^[^\\/]{1,128}\.es3$/i.test(status.selectedSave || "") || status.selectedSave.includes(".."))
      throw new ApiResponseError("No valid active save identity");
    if (!/^[a-f0-9]{64}$/i.test(status.snapshotHash || "") ||
        snapshot.snapshotHash !== status.snapshotHash || snapshot.sourceSave !== status.selectedSave ||
        Date.parse(snapshot.saveWriteTimeUtc) !== Date.parse(status.lastSaveWriteTime))
      throw new ApiResponseError("Snapshot identity is incomplete or inconsistent");
    if (!Number.isSafeInteger(status.productCount) || status.productCount < 1 ||
        status.productCount > AUTO_SYNC_THRESHOLDS.maxProducts || snapshot.products?.length !== status.productCount)
      throw new ApiResponseError("Snapshot product count is suspicious or incomplete");
    const parsed = Date.parse(snapshot.parsedAtUtc), saved = Date.parse(status.lastSaveWriteTime);
    if (!Number.isFinite(parsed) || !Number.isFinite(saved) || parsed > now + 30000 ||
        saved > now + 30000 || parsed + 1000 < saved)
      throw new ApiResponseError("Snapshot is stale or was not parsed after the save write");
    if ((status.warnings || []).some(w => /unverified|unsupported|malformed|truncated|parse error|unknown save format/i.test(w)))
      throw new ApiResponseError("Helper reported a fatal parsing or version warning");
    validateProducts({ schemaVersion: SCHEMA_VERSION, products: snapshot.products }, status);
    validateLicenses({ schemaVersion: SCHEMA_VERSION, unlockedLicenses: snapshot.unlockedLicenses,
      activeLicenses: snapshot.activeLicenses });
    for (const product of snapshot.products) {
      if ([product.supplierUnitPrice, product.supplierBoxPrice, product.averageCost, product.marketPrice,
           product.playerSellPrice, product.purchaseQuantity].some(field => field.status === "invalid"))
        throw new ApiResponseError(`Product ${product.productId}: snapshot contains an invalid price`);
    }
    return snapshotIdentity(status);
  }
  function autoSyncDecision({ status, snapshot, review, baseline }) {
    const snapshotId = validateAutoSyncSnapshot(status, snapshot);
    if (!baseline) return { action: review.diffs.length ? "baseline-review" : "baseline", snapshotId };
    if (baseline.pricingSchemaVersion !== PRICE_SEMANTICS_VERSION)
      return { action: "review", reason: "Price semantics changed; review supplier cost, Average Cost, Market Price and sell price before Auto Sync", snapshotId };
    if (typeof baseline.selectedSave !== "string" || !Number.isSafeInteger(baseline.productCount) ||
        baseline.productCount < 1 || baseline.productCount > AUTO_SYNC_THRESHOLDS.maxProducts ||
        !Number.isSafeInteger(baseline.confirmedMappings) || baseline.confirmedMappings < 0 ||
        !Number.isSafeInteger(baseline.ambiguousMappings) || baseline.ambiguousMappings < 0 ||
        !Number.isSafeInteger(baseline.gameUnmapped) || baseline.gameUnmapped < 0)
      return { action: "pause", reason: "Stored Auto Sync baseline is invalid; establish it again through Review Changes", snapshotId };
    if (status.selectedSave !== baseline.selectedSave)
      return { action: "pause", reason: "Save slot changed; review and set a new baseline", snapshotId };
    if (status.productCount !== baseline.productCount)
      return { action: "review", reason: "Game product count changed; review the new mapping audit", snapshotId };
    if (review.coverage.confirmed < baseline.confirmedMappings ||
        review.coverage.ambiguous > baseline.ambiguousMappings ||
        review.coverage.gameUnmapped > baseline.gameUnmapped)
      return { action: "review", reason: "Product mapping changed or new products need review", snapshotId };
    const changedProducts = new Set(review.diffs.map(d => d.productId)).size;
    if (review.coverage.confirmed && changedProducts / review.coverage.confirmed > AUTO_SYNC_THRESHOLDS.maxChangedProductRatio)
      return { action: "review", reason: "Large price change needs manual review", snapshotId };
    if (status.gameVersion !== baseline.gameVersion)
      return { action: "version-changed", reason: `Game version changed to ${status.gameVersion}; confirmed mapping and product count remain stable`, snapshotId };
    return { action: "apply", snapshotId };
  }
  function whitelistAutoDiffs(diffs, products) {
    const byId = new Map(products.map(p => [p.productId, p]));
    return diffs.filter(d => {
      const p = byId.get(d.productId), field = ({ yourPrice: p?.playerSellPrice,
        marketPrice: p?.marketPrice, supplierUnitPrice: p?.supplierUnitPrice,
        averageCost: p?.averageCost,
        onlineBuyPrice: p?.supplierBoxPrice })[d.field];
      return AUTO_SYNC_FIELDS.has(d.field) && d.mappingStatus === "confirmed" &&
        TRUSTED_MAPPINGS.has(p?.gameData?.auditStatus) && field?.status === "present" &&
        field.value === d.to && typeof field.source === "string" &&
        (d.field === "yourPrice" ? field.source.startsWith(`Price.value.PricesSetByPlayer[${d.productId}].`) :
         d.field === "supplierUnitPrice" ? field.source.startsWith(`Price.value.PricingDatas[${d.productId}].`) :
         d.field === "averageCost" ? field.source === `Price.value.AverageCosts[${d.productId}].Price` :
         d.field === "onlineBuyPrice" ? field.source.startsWith(`derived:Price.value.PricingDatas[${d.productId}].`) :
          field.source === `derived:Pricing[${d.productId}].MarketPrice`);
    });
  }
  function validateProducts(data, status) {
    requireSchema(data, "/products");
    if (!Array.isArray(data.products) || data.products.length !== status.productCount)
      throw new ApiResponseError("Product count mismatch");
    const ids = new Set();
    for (const product of data.products) {
      const id = product?.productId;
      if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id))
        throw new ApiResponseError("Invalid or duplicate ProductID");
      ids.add(id);
      validField(product.purchaseQuantity, id, "purchaseQuantity", "game-data:ProductSO[{id}].PurchaseQuantity");
      validField(product.supplierUnitPrice, id, "supplierUnitPrice", "Price.value.PricingDatas[{id}].Price");
      validField(product.supplierBoxPrice, id, "supplierBoxPrice", "derived:Price.value.PricingDatas[{id}].Price");
      validField(product.averageCost, id, "averageCost", "Price.value.AverageCosts[{id}].Price");
      validField(product.marketPrice, id, "marketPrice", "derived:Pricing[{id}].MarketPrice");
      validField(product.playerSellPrice, id, "playerSellPrice", "Price.value.PricesSetByPlayer[{id}].Price");
      validBooleanField(product.activeInProductList, id, "activeInProductList",
        "Progression.value.LicenseProductsDatas[*].DisabledProductIDs");
      if (product.supplierBoxPrice.status === "present" &&
          JSON.stringify(product.supplierBoxPrice.derivedFrom) !==
            JSON.stringify(["supplierUnitPrice", "gameData.purchaseQuantity"]))
        throw new ApiResponseError(`Product ${id}: box price derivation is missing`);
      if (product.marketPrice.status === "present" &&
          JSON.stringify(product.marketPrice.derivedFrom) !==
            JSON.stringify(["supplierUnitPrice", "gameData.optimumProfitRate"]))
        throw new ApiResponseError(`Product ${id}: market price derivation is missing`);
      if (product.supplierBoxPrice.status === "present" &&
          (product.supplierUnitPrice.status !== "present" || product.purchaseQuantity.status !== "present" ||
           !pricesEqual(product.supplierBoxPrice.value,
             product.supplierUnitPrice.value * product.purchaseQuantity.value)))
        throw new ApiResponseError(`Product ${id}: inconsistent supplier box price`);
      if (product.gameData != null &&
          (product.gameData.productId !== id || typeof product.gameData.assetName !== "string" ||
           typeof product.gameData.mappingStatus !== "string"))
        throw new ApiResponseError(`Product ${id}: malformed game metadata`);
      if (product.gameData?.mappingStatus === "mapped" && product.gameData.auditStatus != null &&
          !["confirmed-exact", "confirmed-alias", "confirmed-metadata"].includes(product.gameData.auditStatus))
        throw new ApiResponseError(`Product ${id}: unconfirmed mapping marked applicable`);
    }
  }
  function validateLicenses(data) {
    requireSchema(data, "/licenses");
    for (const key of ["unlockedLicenses", "activeLicenses"])
      if (!Array.isArray(data[key]) || data[key].some(x => !Number.isSafeInteger(x) || x < 0))
        throw new ApiResponseError(`Malformed ${key}`);
  }
  function pricesEqual(a, b) {
    return typeof a === "number" && typeof b === "number" &&
      Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= PRICE_EPSILON;
  }
  function calculateInventoryProfit(sellPrice, averageCost, discountPct = 0) {
    if (![sellPrice, averageCost, discountPct].every(Number.isFinite) || sellPrice < 0 || averageCost < 0 ||
        discountPct < 0 || discountPct > 100) return null;
    return sellPrice * (1 - discountPct / 100) - averageCost;
  }
  function priceStateEqual(a, b) { return (a == null && b == null) || pricesEqual(a, b); }
  function fingerprint(status, products) {
    const ordered = [...products].sort((a, b) => a.productId - b.productId);
    const text = `${status.selectedSave}|${status.lastSaveWriteTime}|` + ordered.map(p =>
      `${p.productId}:${p.supplierUnitPrice.status}:${p.supplierUnitPrice.value}:` +
      `${p.supplierBoxPrice.status}:${p.supplierBoxPrice.value}:` +
      `${p.averageCost.status}:${p.averageCost.value}:` +
      `${p.marketPrice.status}:${p.marketPrice.value}:` +
      `${p.playerSellPrice.status}:${p.playerSellPrice.value}`).join("|");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${status.selectedSave}:${status.lastSaveWriteTime}:${(hash >>> 0).toString(16)}`;
  }
  function isBakedGameOnly(product) {
    return product.gameData?.productType === "bakery-baked" || product.productId >= 274 && product.productId <= 302 &&
      product.productId % 2 === 0 && /_Baked$/.test(product.gameData?.assetName || "");
  }
  function buildReview(gameProducts, trackerProducts) {
    const byName = new Map(), idCounts = new Map(), keyCounts = new Map();
    for (const product of trackerProducts) {
      const list = byName.get(product.name) || [];
      list.push(product); byName.set(product.name, list);
      if (product.productId != null) idCounts.set(product.productId, (idCounts.get(product.productId) || 0) + 1);
    }
    for (const game of gameProducts) {
      const data = game.gameData;
      if (data?.mappingStatus === "mapped" && typeof data.trackerKey === "string")
        keyCounts.set(data.trackerKey, (keyCounts.get(data.trackerKey) || 0) + 1);
    }
    const issues = [], audit = [], diffs = [], matchedNames = new Set();
    let confirmed = 0, bakeryGameOnly = 0, ambiguous = 0, unknownProductSO = 0;
    for (const game of gameProducts) {
      const data = game.gameData, key = data?.trackerKey || null;
      const issueBase = { productId: game.productId, gameMetadata: data?.assetName || "(no ProductSO)",
        trackerCandidate: key || data?.trackerCandidates?.join("; ") || "", category: data?.category || "",
        brand: data?.brand || "", license: data?.license != null ? `Tracker ${data.license}` :
          data?.gameLicenseIds?.length ? `Game ID ${data.gameLicenseIds.join(", ")}` : "",
        dlc: data?.dlc || null, productType: data?.productType || "unknown",
        reason: data?.reason || "No verified mapping", confidence: data?.confidence || "unknown",
        source: data?.source || null, metadata: data?.metadata || null };
      if (!data || data.auditStatus === "game-asset-missing") unknownProductSO++;
      if (isBakedGameOnly(game)) {
        bakeryGameOnly++;
        issues.push({ ...issueBase, status: "bakery-baked" });
        continue;
      }
      if (data?.mappingStatus !== "mapped" || !key || (data.auditStatus != null &&
          !["confirmed-exact", "confirmed-alias", "confirmed-metadata"].includes(data.auditStatus))) {
        if (data?.auditStatus === "ambiguous") ambiguous++;
        issues.push({ ...issueBase, status: data?.auditStatus || "unmapped" });
        continue;
      }
      const candidates = byName.get(key) || [];
      if (keyCounts.get(key) !== 1 || candidates.length > 1 ||
          (candidates.length === 1 && candidates[0].productId != null && candidates[0].productId !== game.productId) ||
          idCounts.get(game.productId) > 1 ||
          trackerProducts.some(p => p.productId === game.productId && p.name !== key)) {
        ambiguous++;
        issues.push({ ...issueBase, status: "ambiguous", reason: "ProductID or tracker identity conflicts with an existing assignment" });
        continue;
      }
      if (candidates.length === 0) {
        issues.push({ ...issueBase, status: "game-only" });
        continue;
      }
      const tracker = candidates[0];
      confirmed++; matchedNames.add(key);
      audit.push({ ...issueBase, status: data?.auditStatus || "confirmed", trackerCandidate: key });
      for (const [field, label, current, fieldValue] of [
        ["supplierUnitPrice", priceLabel("Supplier unit price"), tracker.supplierUnitPrice, game.supplierUnitPrice],
        ["onlineBuyPrice", priceLabel("Online box price"), tracker.onlineBuyPrice, game.supplierBoxPrice],
        ["averageCost", priceLabel("Average cost / item"), tracker.averageCost, game.averageCost],
        ["marketPrice", priceLabel("Market price"), tracker.marketPrice, game.marketPrice],
        ["yourPrice", priceLabel("Player sell price"), tracker.yourPrice, game.playerSellPrice],
      ]) {
        if (fieldValue.status !== "present") continue; // sparse save never erases tracker data
        if (!pricesEqual(current, fieldValue.value))
          diffs.push({ key: `${game.productId}:${field}`, productId: game.productId,
            trackerName: key, field, label, from: current ?? null,
            to: fieldValue.value, source: fieldValue.source, mappingStatus: "confirmed",
            purchaseQuantity: game.purchaseQuantity.status === "present" ? game.purchaseQuantity.value : null,
            averageCostStatus: game.averageCost.status });
      }
    }
    for (const tracker of trackerProducts)
      if (!matchedNames.has(tracker.name))
        issues.push({ productId: tracker.productId ?? null, gameMetadata: "", trackerCandidate: tracker.name,
          category: tracker.cat || "", license: tracker.license || "", status: "tracker-only / unmapped",
          reason: "No unique confirmed game mapping for this tracker row" });
    return { diffs, issues, audit: [...audit, ...issues], coverage: {
      confirmed, trackerUnmapped: trackerProducts.length - matchedNames.size,
      gameUnmapped: gameProducts.length - confirmed, bakeryGameOnly, ambiguous, unknownProductSO,
    } };
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }
  function formatPrice(value) { return value == null ? "—" : String(value); }
  function formatTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "—";
  }
  function normalizePreferences(value) {
    return { mode: ["read-only", "review", "auto"].includes(value?.mode) ? value.mode : "review",
      ignoredFingerprint: typeof value?.ignoredFingerprint === "string" ? value.ignoredFingerprint : null,
      notifyAfterAutoSync: value?.notifyAfterAutoSync !== false };
  }
  function shouldSuppressDiff(ignoredFingerprint, activeFingerprint) {
    return !!activeFingerprint && ignoredFingerprint === activeFingerprint;
  }

  let client = new GameSyncClient();
  let prefs = normalizePreferences(null);
  let lastStatus = null, lastProducts = null, lastLicenses = null, lastReview = null, lastHelperConnected = false;
  let currentFingerprint = null, lastCheckAt = null, uiState = "offline", uiError = "";
  let productActivityById = null;
  let timer = null, pending = null, offlineDelay = 5000;
  let reviewedDiffs = [], lastSnapshot = null, autoPauseReason = "", autoConsentPending = false, baselineReviewOpen = false;
  function updateProductActivity(products) {
    const next = Array.isArray(products) ? new Map(products.map(p => [p.productId, p.activeInProductList])) : null;
    const previous = productActivityById;
    const changed = previous === null ? next !== null : next === null || previous.size !== next.size ||
      [...previous].some(([id, field]) => {
        const other = next.get(id);
        return !other || other.status !== field.status || other.value !== field.value;
      });
    productActivityById = next;
    if (changed) root.renderProductTable?.();
  }
  function getProductActiveStatus(productId) {
    const field = Number.isSafeInteger(productId) ? productActivityById?.get(productId) : null;
    return field?.status === "present" && typeof field.value === "boolean" ? field.value : null;
  }
  function render() {
    const panel = root.document?.getElementById("gameSyncPanel");
    if (!panel) return;
    const labels = { connected: prefs.mode === "auto" ? "🟢 Auto Sync" : "🟢 Connected", offline: "🟡 Helper unavailable",
      save: "🟡 Save unavailable", warning: "🟡 Parsing warning",
      incompatible: "🔴 API version incompatible", error: "🔴 Connection error", paused: "🟡 Auto Sync paused",
      review: "🟡 Auto Sync paused · Review required", baseline: "🟡 Initial synchronization required" };
    root.document.getElementById("gameSyncStatus").textContent = uiText(labels[uiState] || labels.error);
    const count = lastReview?.diffs.length || 0;
    const ignored = shouldSuppressDiff(prefs.ignoredFingerprint, currentFingerprint);
    const status = lastStatus || {};
    const lastBatch=Array.isArray(state.gameSyncBatches) ? state.gameSyncBatches.at(-1) : null;
    const currentSnapshotId=status.snapshotHash ? snapshotIdentity(status) : null;
    const undoneCurrentSnapshot=currentSnapshotId && isSuppressedSnapshot(state.gameSyncMeta,currentSnapshotId);
    root.document.getElementById("gameSyncDetails").innerHTML =
      `<span>Tracker: <b>v${escapeHtml(TRACKER_VERSION)}</b></span>` +
      `<span>Sync Helper: <b>${escapeHtml(status.helperVersion || "—")}</b></span>` +
      `<span>API schema: <b>${escapeHtml(status.schemaVersion == null ? "—" : String(status.schemaVersion))}</b></span>` +
      `<span>Mapping data: <b>${escapeHtml(status.mappingDataVersion || "—")}</b></span>` +
      `<span>Game: <b>${escapeHtml(status.gameVersion || "—")}</b></span>` +
      `<span>Save: <b>${escapeHtml(status.selectedSave || "—")}</b></span>` +
      `<span>Last save: <b>${escapeHtml(formatTime(status.lastSaveWriteTime))}</b></span>` +
      `<span>Last sync check: <b>${escapeHtml(formatTime(lastCheckAt))}</b></span>` +
      `<span>Last batch: <b>${escapeHtml(lastBatch ? uiT("gameSync.lastBatch", { products: lastBatch.productCount, fields: lastBatch.changeCount, date: formatTime(new Date(lastBatch.savedAt).toISOString()) }) + (lastBatch.undoneAt ? " · " + uiText("undone") : "") : "—")}</b></span>` +
      `<span>Game products: <b>${lastProducts?.length ?? 0}</b></span>` +
      `<span>Confirmed mappings: <b>${lastReview?.coverage.confirmed ?? 0}</b></span>` +
      `<span>Changes detected: <b>${ignored ? 0 : count}</b></span>` +
      `<span>Unmapped game products: <b>${lastReview?.coverage.gameUnmapped ?? 0}</b></span>` +
      `<span>Tracker unmapped: <b>${lastReview?.coverage.trackerUnmapped ?? 0}</b></span>` +
      `<span>Game-only Bakery products: <b>${lastReview?.coverage.bakeryGameOnly ?? 0}</b></span>` +
      `<span>Products requiring mapping review: <b>${lastReview?.coverage.ambiguous ?? 0}</b></span>` +
      `<span>Supplier prices: <b>saved current cost + derived game box quantity</b></span>` +
      `<span>Unlocked game licenses: <b>${lastLicenses?.unlockedLicenses.length ?? 0}</b></span>`;
    root.document.getElementById("gameSyncMode").value = prefs.mode;
    root.document.getElementById("gameSyncNotify").checked = prefs.notifyAfterAutoSync !== false;
    const resume=root.document.getElementById("gameSyncResumeBtn");
    resume.hidden=!(prefs.mode === "auto" && state.gameSyncMeta?.hold);
    root.document.getElementById("gameSyncReviewBtn").disabled = !["connected", "review", "baseline"].includes(uiState) || !count || ignored;
    root.document.getElementById("gameSyncIssuesBtn").disabled = !lastReview;
    root.document.getElementById("gameSyncNote").textContent = uiText(autoPauseReason || (undoneCurrentSnapshot ?
      "The last Auto Sync was undone. This save snapshot is suppressed; a new game save can sync again." : ignored ?
      "Changes ignored for this save snapshot; a new game value will appear again." :
      uiError || (prefs.mode === "read-only" ? "Read Only: game data is visible; Apply is disabled." :
      prefs.mode === "auto" ? `${lastReview?.diffs.length || 0} pending changes. Pickup prices remain in tracker/manual data.` :
      "Only confirmed ProductID mappings can be applied. Missing prices are never cleared.")));
    updateActivityUi();
  }
  function createUi() {
    if (!root.document || root.document.getElementById("gameSyncPanel")) return;
    const style = root.document.createElement("style");
    style.textContent = `.game-sync-card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12px}.game-sync-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}.game-sync-head strong{font-size:13px}.game-sync-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:3px 12px;color:var(--text2);margin:5px 0 8px}.game-sync-grid b{color:var(--text)}.game-sync-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.game-sync-note{color:var(--text3);font-size:11px;margin-top:6px}.game-sync-table-wrap{overflow:auto;max-height:52vh;margin:8px 0}.game-sync-table{min-width:650px}.game-sync-table td,.game-sync-table th{padding:5px 7px}.game-sync-table th{cursor:default}.game-sync-table input{accent-color:var(--accent)}`;
    root.document.head.appendChild(style);
    const panel = root.document.createElement("section");
    panel.id = "gameSyncPanel"; panel.className = "game-sync-card";
    panel.innerHTML = `<div class="game-sync-head"><strong>Game Sync</strong><span id="gameSyncStatus">🟡 Helper unavailable</span></div><div id="gameSyncDetails" class="game-sync-grid"></div><div class="game-sync-actions"><button class="btn act" id="gameSyncReviewBtn" disabled>Review Changes</button><button class="btn" id="gameSyncRefreshBtn">Refresh</button><button class="btn" id="gameSyncIssuesBtn" disabled>View mapping issues</button><label for="gameSyncMode">Mode:</label><select id="gameSyncMode"><option value="review">Review Changes</option><option value="read-only">Read Only</option><option value="auto">Auto Sync</option></select><label><input id="gameSyncNotify" type="checkbox" checked> Notify after Auto Sync</label><button class="btn" id="gameSyncResumeBtn" hidden>Resume / review new baseline</button></div><div class="game-sync-actions"><button class="btn" id="gameSyncActivityBtn">View Activity</button><button class="btn" id="gameSyncUndoBtn" disabled>Undo Last Sync</button></div><div id="gameSyncNote" class="game-sync-note">Optional local helper; tracker works without it.</div>`;
    root.document.querySelector(".content")?.prepend(panel);
    for (const [id, title, width] of [["gameSyncReviewModal", "Review Game Changes", 900], ["gameSyncIssuesModal", "Mapping Issues", 950]]) {
    const overlay = root.document.createElement("div");
      overlay.id = id; overlay.className = "modal-overlay";
      overlay.innerHTML = `<div class="modal" style="width:${width}px"><button class="close-btn" data-close="${id}">×</button><h3>${title}</h3><div id="${id}Content"></div></div>`;
      root.document.body.appendChild(overlay);
      overlay.querySelector("[data-close]").addEventListener("click", () => {
        if (id === "gameSyncReviewModal") baselineReviewOpen = false;
        closeModal(id);
      });
    }
    const confirmOverlay = root.document.createElement("div");
    confirmOverlay.id = "gameSyncAutoConfirmModal"; confirmOverlay.className = "modal-overlay";
    confirmOverlay.innerHTML = `<div class="modal" style="max-width:520px"><h3>Enable Auto Sync?</h3><p>Confirmed game prices will be applied automatically after each validated game save. The game save remains read-only.</p><p><b>Synced:</b> Supplier unit cost, derived Online box cost, Average Cost, Market Price, and Player Sell Price when present.</p><p><b>Preserved:</b> Pickup Buy Price.</p><p id="gameSyncAutoBaseline" class="game-sync-note"></p><p class="game-sync-note">A backup has not been confirmed in this localhost browser storage. Download a Backup first, or continue; you can create one at any time.</p><div class="game-sync-actions"><button class="btn" id="gameSyncAutoBackupBtn">Download Backup</button><button class="btn act" id="gameSyncAutoEnableBtn">Enable Auto Sync</button><button class="btn" id="gameSyncAutoCancelBtn">Cancel</button></div></div>`;
    root.document.body.appendChild(confirmOverlay);
    confirmOverlay.querySelector("#gameSyncAutoEnableBtn").addEventListener("click", confirmAutoSync);
    confirmOverlay.querySelector("#gameSyncAutoCancelBtn").addEventListener("click", cancelAutoSync);
    confirmOverlay.querySelector("#gameSyncAutoBackupBtn").addEventListener("click", () => {
      if (typeof root.exportFullBackup === "function") root.exportFullBackup();
      root.localStorage.setItem("smtracker_gameSync_backupOffered_v1", new Date().toISOString());
    });
    const activityOverlay=root.document.createElement("div");activityOverlay.id="gameSyncActivityModal";activityOverlay.className="modal-overlay";
    activityOverlay.innerHTML='<div class="modal" style="max-width:650px"><button class="close-btn" data-close="gameSyncActivityModal">×</button><h3>Game Sync Activity</h3><div id="gameSyncActivityModalContent"></div></div>';
    root.document.body.appendChild(activityOverlay);
    activityOverlay.querySelector("[data-close]").addEventListener("click",()=>closeModal("gameSyncActivityModal"));
    root.document.getElementById("gameSyncReviewBtn").addEventListener("click", openReview);
    root.document.getElementById("gameSyncRefreshBtn").addEventListener("click", () => refresh(true));
    root.document.getElementById("gameSyncIssuesBtn").addEventListener("click", openIssues);
    root.document.getElementById("gameSyncActivityBtn").addEventListener("click", openActivity);
    root.document.getElementById("gameSyncUndoBtn").addEventListener("click", undoLastSync);
    root.document.getElementById("gameSyncResumeBtn").addEventListener("click", enableAutoSync);
    root.document.getElementById("gameSyncNotify").addEventListener("change", e => {
      prefs.notifyAfterAutoSync=e.target.checked; storePreferences();
    });
    root.document.getElementById("gameSyncMode").addEventListener("change", e => setMode(e.target.value));
  }
  function loadPreferences() {
    try { prefs = normalizePreferences(JSON.parse(root.localStorage.getItem(PREFS_KEY))); }
    catch { prefs = normalizePreferences(null); }
    if (prefs.mode === "auto" && root.localStorage.getItem(AUTO_CONSENT_KEY) !== "yes") prefs.mode = "review";
  }
  function storePreferences() {
    try { root.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }
    catch { /* Preferences are optional; tracker data remains untouched. */ }
  }
  function schedule() {
    clearTimeout(timer);
    const wait = uiState === "connected" ? 3000 : offlineDelay;
    timer = setTimeout(() => refresh(false), wait);
    if (uiState !== "connected") offlineDelay = Math.min(30000, offlineDelay * 2);
  }
  function onTrackerDataChanged() {
    if (lastProducts && typeof state !== "undefined") lastReview = buildReview(lastProducts, state.products);
    render();
  }
  function refresh(manual = false) {
    if (manual) clearTimeout(timer);
    if (pending) return pending;
    pending = (async () => {
      try {
        const result = await client.check();
        lastCheckAt = new Date().toISOString();
        lastStatus = result.status;
        if (!result.status.connected) {
          updateProductActivity(null);
          if (lastHelperConnected) {
            recordActivity("helper-disconnected", "Helper disconnected");
            try { persistAndVerifyState(); } catch (e) { console.error("Could not persist helper status activity", e); }
          }
          lastHelperConnected=false;
          uiState = result.status.error ? "warning" : "save";
          uiError = result.status.error || "No active save is available.";
          if (prefs.mode === "auto" && result.status.error) pauseAutoSync(uiError);
          return;
        }
        if (!lastHelperConnected) {
          recordActivity("helper-connected", "Helper connected", { selectedSave: result.status.selectedSave });
          try { persistAndVerifyState(); } catch (e) { console.error("Could not persist helper status activity", e); }
        }
        lastHelperConnected=true;
        updateProductActivity(result.products);
        lastProducts = result.products;
        lastLicenses = result.licenses;
        currentFingerprint = fingerprint(result.status, result.products);
        lastSnapshot = result.snapshot || { ...result.status, products: result.products,
          unlockedLicenses: result.licenses.unlockedLicenses, activeLicenses: result.licenses.activeLicenses,
          saveWriteTimeUtc: result.status.lastSaveWriteTime, parsedAtUtc: result.status.lastSuccessfulParse,
          snapshotHash: result.status.snapshotHash, sourceSave: result.status.selectedSave };
        lastReview = buildReview(result.products, state.products);
        const unverified = (result.status.warnings || []).some(w => /unverified game version|could not be parsed/i.test(w));
        uiState = unverified ? "warning" : "connected";
        uiError = unverified ? "Game version or fields need verification; Apply is disabled." : "";
        offlineDelay = 5000;
        if (prefs.mode === "auto" && unverified) pauseAutoSync(uiError, "review");
        else if (prefs.mode === "auto" && !baselineReviewOpen) processAutoSync();
      } catch (error) {
        updateProductActivity(null);
        if (lastHelperConnected) {
          recordActivity("helper-disconnected", "Helper disconnected");
          try { persistAndVerifyState(); } catch (e) { console.error("Could not persist helper status activity", e); }
        }
        lastHelperConnected=false;
        lastCheckAt = new Date().toISOString();
        uiState = error instanceof ApiSchemaError ? "incompatible" :
          error instanceof ApiResponseError ? "error" : "offline";
        uiError = error.message || "Helper unavailable";
        if (prefs.mode === "auto" && !(error instanceof TypeError)) pauseAutoSync(uiError,
          error instanceof ApiSchemaError ? "paused" : "review");
      } finally { render(); }
    })();
    pending.finally(() => { pending = null; schedule(); });
    return pending;
  }
  function setMode(mode) {
    if (mode === "auto") {
      if (root.localStorage.getItem(AUTO_CONSENT_KEY) === "yes") enableAutoSync();
      else showAutoSyncConfirmation();
      return;
    }
    prefs.mode = mode === "read-only" ? "read-only" : "review";
    storePreferences(); render();
  }
  function showAutoSyncConfirmation() {
    autoConsentPending = true;
    const count = lastReview?.diffs.length || 0;
    root.document.getElementById("gameSyncAutoBaseline").textContent = count ?
      uiT("gameSync.existingDifferences", { count }) :
      uiText("No current price differences. The current validated save will be recorded as the initial baseline.");
    root.document.getElementById("gameSyncAutoConfirmModal").classList.add("open");
  }
  function cancelAutoSync() {
    autoConsentPending = false;
    root.document.getElementById("gameSyncAutoConfirmModal").classList.remove("open");
    root.document.getElementById("gameSyncMode").value = prefs.mode;
  }
  function confirmAutoSync() {
    if (!autoConsentPending) return;
    root.localStorage.setItem(AUTO_CONSENT_KEY, "yes");
    root.document.getElementById("gameSyncAutoConfirmModal").classList.remove("open");
    enableAutoSync();
  }
  function persistAndVerifyState(batchId, options = {}) {
    saveState(true);
    const saved = JSON.parse(root.localStorage.getItem(SK) || "null");
    if (!saved || JSON.stringify(saved.gameSyncMeta) !== JSON.stringify(state.gameSyncMeta) ||
        saved.products?.length !== state.products.length ||
        !state.products.every((p, i) => saved.products[i]?.name === p.name &&
          saved.products[i]?.productId === p.productId && saved.products[i]?.marketPrice === p.marketPrice &&
          saved.products[i]?.yourPrice === p.yourPrice &&
          (saved.products[i]?.supplierUnitPrice ?? null) === (p.supplierUnitPrice ?? null) &&
          (saved.products[i]?.averageCost ?? null) === (p.averageCost ?? null) &&
          (saved.products[i]?.gamePurchaseQuantity ?? null) === (p.gamePurchaseQuantity ?? null) &&
          saved.products[i]?.onlineBuyPrice === p.onlineBuyPrice &&
          saved.products[i]?.pickupBuyPrice === p.pickupBuyPrice) ||
        (batchId && !saved.gameSyncBatches?.some(batch => batch.batchId === batchId)) ||
        (batchId && !options.undo && Object.values(state.priceHistory || {}).flat().some(entry => entry.batchId === batchId) &&
          !Object.values(saved.priceHistory || {}).flat().some(entry => entry.batchId === batchId)) ||
        (options.undo && saved.gameSyncMeta?.lastAutoUndo?.undoneAt !== state.gameSyncMeta?.lastAutoUndo?.undoneAt))
      throw new Error("Saved tracker state could not be verified");
  }
  function recordActivity(type, message, details = {}, targetState) {
    targetState ||= typeof state !== "undefined" ? state : null;
    if (!targetState) return;
    targetState.gameSyncMeta ||= {};
    const entries = Array.isArray(targetState.gameSyncMeta.activity) ? targetState.gameSyncMeta.activity : [];
    entries.unshift({ at: new Date().toISOString(), type, message, ...details });
    targetState.gameSyncMeta.activity = entries.slice(0, 30);
  }
  function establishBaseline(snapshot, review) {
    state.gameSyncMeta ||= {};
    const snapshotId = snapshotIdentity(lastStatus);
    const ids = processedSnapshotIds(state.gameSyncMeta);
    if (!ids.includes(snapshotId)) ids.push(snapshotId);
    state.gameSyncMeta.processedSnapshotIds = ids.slice(-512);
    state.gameSyncMeta.lastProcessedSnapshotId = snapshotId;
    state.gameSyncMeta.pricingSchemaVersion = PRICE_SEMANTICS_VERSION;
    state.gameSyncMeta.semanticMigrationAt ||= Date.now();
    state.gameSyncMeta.baseline = { selectedSave: lastStatus.selectedSave, snapshotId,
      pricingSchemaVersion: PRICE_SEMANTICS_VERSION,
      gameVersion: lastStatus.gameVersion, productCount: lastStatus.productCount,
      confirmedMappings: review.coverage.confirmed, ambiguousMappings: review.coverage.ambiguous,
      gameUnmapped: review.coverage.gameUnmapped, establishedAt: new Date().toISOString() };
    delete state.gameSyncMeta.hold;
    delete state.gameSyncMeta.forceBaselineReview;
    persistAndVerifyState();
  }
  function pauseAutoSync(reason, stateName = "paused") {
    const existingHold=state.gameSyncMeta?.hold;
    if (existingHold?.reason === reason && existingHold?.state === stateName) {
      autoPauseReason = `Auto Sync paused: ${reason}`; uiState = stateName; return;
    }
    autoPauseReason = `Auto Sync paused: ${reason}`; uiState = stateName;
    try { state.gameSyncMeta ||= {}; state.gameSyncMeta.hold = { reason, at: new Date().toISOString(), state: stateName }; }
    catch (e) { console.error("Could not persist Auto Sync pause state", e); }
    recordActivity(stateName, autoPauseReason);
    try { persistAndVerifyState(); } catch (e) { console.error("Could not persist sync activity", e); }
  }
  function enableAutoSync() {
    prefs.mode = "auto"; autoPauseReason = ""; autoConsentPending = false;
    storePreferences();
    const semanticMigration = (state.gameSyncMeta?.pricingSchemaVersion != null &&
      state.gameSyncMeta.pricingSchemaVersion !== PRICE_SEMANTICS_VERSION) ||
      (!!state.gameSyncMeta?.baseline && state.gameSyncMeta.baseline.pricingSchemaVersion !== PRICE_SEMANTICS_VERSION);
    const forceBaseline = !!state.gameSyncMeta?.hold || semanticMigration;
    if (!lastStatus?.connected || !lastSnapshot) {
      uiState = "paused"; autoPauseReason = "Auto Sync paused: waiting for a fully validated save snapshot.";
    } else if (forceBaseline || !state.gameSyncMeta?.baseline) {
      state.gameSyncMeta ||= {};
      state.gameSyncMeta.forceBaselineReview = semanticMigration || !!lastReview?.diffs.length;
      if (lastReview?.diffs.length || semanticMigration) {
        uiState = "baseline"; autoPauseReason = `Initial synchronization required: review and apply all ${lastReview.diffs.length} differences.`;
        recordActivity("baseline-required", autoPauseReason, { changes: lastReview.diffs.length });
        try { persistAndVerifyState(); }
        catch (error) { pauseAutoSync(`Could not persist baseline requirement: ${error.message}`); return; }
      } else {
        establishBaseline(lastSnapshot, lastReview);
        recordActivity("baseline", "Initial Auto Sync baseline established"); persistAndVerifyState();
      }
    } else if (state.gameSyncMeta?.hold) {
      uiState = state.gameSyncMeta.hold.state || "paused"; autoPauseReason = `Auto Sync paused: ${state.gameSyncMeta.hold.reason}`;
    } else uiState = "connected";
    render();
    if (uiState === "baseline") { baselineReviewOpen=true; openReview(); }
  }
  function processAutoSync() {
    if (prefs.mode !== "auto") return;
    if (state.gameSyncMeta?.pricingSchemaVersion != null &&
        state.gameSyncMeta.pricingSchemaVersion !== PRICE_SEMANTICS_VERSION) {
      state.gameSyncMeta.forceBaselineReview = true;
      pauseAutoSync("Price semantics changed; Migration Review is required before Auto Sync.", "review"); return;
    }
    if (state.gameSyncMeta?.baseline && state.gameSyncMeta.baseline.pricingSchemaVersion !== PRICE_SEMANTICS_VERSION) {
      state.gameSyncMeta.forceBaselineReview = true;
      pauseAutoSync("Price semantics changed; Migration Review is required before Auto Sync.", "review"); return;
    }
    if (state.gameSyncMeta?.hold) { pauseAutoSync(state.gameSyncMeta.hold.reason, state.gameSyncMeta.hold.state); return; }
    if (!lastSnapshot || !lastReview) { pauseAutoSync("No complete save snapshot is available."); return; }
    let snapshotId;
    try { snapshotId = validateAutoSyncSnapshot(lastStatus, lastSnapshot); }
    catch (error) { pauseAutoSync(error.message); return; }
    const baseline = state.gameSyncMeta?.baseline;
    if (!baseline) {
      if (lastReview.diffs.length) pauseAutoSync(`Initial synchronization required: ${lastReview.diffs.length} changes need review.`, "baseline");
      else {
        try { establishBaseline(lastSnapshot, lastReview); recordActivity("baseline", "Initial Auto Sync baseline established"); persistAndVerifyState(); }
        catch (error) { pauseAutoSync(`Could not persist initial baseline: ${error.message}`); }
      }
      return;
    }
    let decision;
    try { decision = autoSyncDecision({ status: lastStatus, snapshot: lastSnapshot, review: lastReview, baseline }); }
    catch (error) { pauseAutoSync(`Snapshot or baseline validation failed: ${error.message}`, "review"); return; }
    if (["pause", "review"].includes(decision.action)) { pauseAutoSync(decision.reason, decision.action === "review" ? "review" : "paused"); return; }
    if (decision.action === "baseline-review") { pauseAutoSync(`Initial synchronization required: ${lastReview.diffs.length} changes need review.`, "baseline"); return; }
    if (decision.action === "version-changed") {
      state.gameSyncMeta.baseline = { ...baseline, gameVersion: lastStatus.gameVersion,
        snapshotId, establishedAt: new Date().toISOString() };
      try { recordActivity("version", decision.reason); persistAndVerifyState(); }
      catch (error) { pauseAutoSync(`Could not persist the game version check: ${error.message}`); return; }
      showToast("Game version changed · mapping verified");
    }
    if (isSuppressedSnapshot(state.gameSyncMeta,snapshotId) || processedSnapshotIds(state.gameSyncMeta).includes(snapshotId)) return;
    const diffs = whitelistAutoDiffs(lastReview.diffs, lastProducts);
    if (diffs.length !== lastReview.diffs.length) { pauseAutoSync("A field or mapping is outside the Auto Sync whitelist.", "review"); return; }
    const changedProducts = new Set(diffs.map(d => d.productId)).size;
    if (lastReview.coverage.confirmed && changedProducts / lastReview.coverage.confirmed > AUTO_SYNC_THRESHOLDS.maxChangedProductRatio) {
      pauseAutoSync("More than 25% of confirmed products changed; Review Changes is required.", "review"); return;
    }
    if (!diffs.length) {
        try {
          state.gameSyncMeta ||= {};
          const ids = processedSnapshotIds(state.gameSyncMeta);
          if (!ids.includes(snapshotId)) ids.push(snapshotId);
          state.gameSyncMeta.processedSnapshotIds = ids.slice(-512);
          state.gameSyncMeta.lastProcessedSnapshotId = snapshotId;
          recordActivity("no-changes", "No price changes"); persistAndVerifyState();
        }
        catch (error) { pauseAutoSync(`Could not record snapshot identity: ${error.message}`); }
      return;
    }
    try {
      const result = commitSyncBatch(diffs, { source: "game-auto-sync", mode: "auto", snapshotId, selectedSave: lastStatus.selectedSave });
      showToast(`${result.productCount} products updated`);
    } catch (error) { pauseAutoSync(`Batch was rolled back: ${error.message}`); }
  }
  function captureUndo(diffs) {
    const names = [...new Set(diffs.map(d => d.trackerName))];
    return { products: names.map(name => ({ name,
      product: JSON.parse(JSON.stringify(state.products.find(p => p.name === name))),
      history: JSON.parse(JSON.stringify(state.priceHistory[name] || [])) })) };
  }
  const UNDO_PRICE_FIELDS = ["productId", "supplierUnitPrice", "gamePurchaseQuantity", "averageCost", "onlineBuyPrice",
    "marketPrice", "yourPrice", "pricingSchemaVersion"];
  const UNDO_PRE_AVERAGE_FIELDS = ["productId", "supplierUnitPrice", "gamePurchaseQuantity", "onlineBuyPrice",
    "marketPrice", "yourPrice", "pricingSchemaVersion"];
  const UNDO_LEGACY_PRODUCT_FIELDS = ["productId", "marketPrice", "yourPrice", "onlineBuyPrice", "pickupBuyPrice",
    "averageCost", "items", "weight", "shelf", "storage", "isWeight", "isVending", "hasPickup",
    "license", "dlc", "dlcGroup", "cat", "brand"];
  function undoProductSignature(product) {
    return JSON.stringify(UNDO_PRICE_FIELDS.map(key => [key, product?.[key] ?? null]));
  }
  function matchesUndoProductSignature(product, expected) {
    return expected === undoProductSignature(product) ||
      expected === JSON.stringify(UNDO_PRE_AVERAGE_FIELDS.map(key => [key, product?.[key] ?? null])) ||
      expected === JSON.stringify(["productId", "marketPrice", "yourPrice"].map(key => [key, product?.[key] ?? null])) ||
      expected === JSON.stringify(UNDO_LEGACY_PRODUCT_FIELDS.map(key => [key, product?.[key] ?? null]));
  }
  function commitSyncBatch(diffs, { source, mode, snapshotId, selectedSave }) {
    const batchId = `game-${mode}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const previous = mode === "auto" ? captureUndo(diffs) : null;
    const undoRecord = previous ? { ...previous, batchId, snapshotId,
      appliedAt: new Date().toISOString(), fieldCount: diffs.length,
      productCount: new Set(diffs.map(d => d.productId)).size } : null;
    const oldRaw = root.localStorage.getItem(SK);
    const result = runAtomicApply({ trackerState: state, selected: diffs, batchId, selectedSave,
      snapshotFingerprint: snapshotId, snapshotId, source, mode, undoRecord, update: updateTrackedProduct,
      recalc: () => calcStars(state.products), persist: () => persistAndVerifyState(batchId),
      afterCommit: () => { renderCurrentTab(); onTrackerDataChanged(); },
      restore: oldState => { state=oldState; if (oldRaw==null) root.localStorage.removeItem(SK); else root.localStorage.setItem(SK,oldRaw); renderCurrentTab(); onTrackerDataChanged(); } });
    return { ...result, batchId };
  }
  function showToast(message) {
    if (!prefs.notifyAfterAutoSync) return;
    const old = root.document?.getElementById("gameSyncToast"); old?.remove();
    const toast = root.document?.createElement("div");
    if (!toast) return;
    toast.id = "gameSyncToast"; toast.textContent = uiT("gameSync.toast", { message: uiText(message) });
    toast.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:150;background:var(--bg2);color:var(--text);border:1px solid var(--accent);border-radius:8px;padding:10px 14px;box-shadow:0 4px 18px #0008";
    root.document.body.appendChild(toast); setTimeout(() => toast.remove(), 3500);
  }
  function updateActivityUi() {
    if (!root.document) return;
    const button=root.document.getElementById("gameSyncUndoBtn"), undo=state?.gameSyncMeta?.lastAutoUndo;
    const latest=Array.isArray(state?.gameSyncBatches) ? state.gameSyncBatches.at(-1) : null;
    const undoProducts=Array.isArray(undo?.products) ? undo.products : [];
    const unchanged=undoProducts.length > 0 && undoProducts.every(saved => {
      const current=state.products.find(p=>p.name===saved.name);
      const expected=undo.afterProducts?.find(p=>p.name===saved.name);
      const history=state.priceHistory?.[saved.name] || [];
      const entry=history.at(-1);
      return current && expected && matchesUndoProductSignature(current,expected.signature) &&
        entry?.batchId===undo.batchId && entry?.source==="game-auto-sync";
    });
    if (button) {
      button.disabled=!undo || !!undo.undoneAt || latest?.batchId !== undo.batchId || !unchanged;
      button.title=undo && (latest?.batchId !== undo.batchId || !unchanged) ?
        "Undo is unavailable because a later tracker change would be overwritten." : "Undo the latest Auto Sync batch";
    }
  }
  function openActivity() {
    const entries=Array.isArray(state.gameSyncMeta?.activity) ? state.gameSyncMeta.activity : [];
    root.document.getElementById("gameSyncActivityModalContent").innerHTML=entries.length ?
      `<ul>${entries.map(e=>`<li>${escapeHtml(formatTime(e.at))} · ${escapeHtml(uiText(e.type))}${e.selectedSave ? ` · ${escapeHtml(e.selectedSave)}` : ""} · ${escapeHtml(uiText(e.message))}</li>`).join("")}</ul>` : "No sync activity yet.";
    root.document.getElementById("gameSyncActivityModal").classList.add("open");
  }
  function undoLastSync() {
    const record=state.gameSyncMeta?.lastAutoUndo;
    if (!record || record.undoneAt) return;
    const oldRaw=root.localStorage.getItem(SK), before=JSON.parse(JSON.stringify(state));
    try {
      const latest = Array.isArray(state.gameSyncBatches) ? state.gameSyncBatches.at(-1) : null;
      if (!latest || latest.batchId !== record.batchId || latest.mode !== "auto")
        throw new Error("The latest tracker batch is no longer the last Auto Sync batch");
      for (const saved of record.products) {
        const index=state.products.findIndex(p=>p.name===saved.name);
        if (index<0) throw new Error(`Product ${saved.name} no longer exists`);
        const expected=record.afterProducts?.find(p=>p.name===saved.name);
        const latestHistory=(state.priceHistory[saved.name] || []).at(-1);
        if (!expected || !matchesUndoProductSignature(state.products[index],expected.signature) ||
            latestHistory?.batchId!==record.batchId || latestHistory?.source!=="game-auto-sync")
          throw new Error(`A later tracker edit exists for ${saved.name}; Undo was not applied`);
        state.products[index]={...state.products[index], productId:saved.product.productId ?? null,
          supplierUnitPrice:saved.product.supplierUnitPrice ?? null,
          averageCost:saved.product.averageCost ?? null,
          gamePurchaseQuantity:saved.product.gamePurchaseQuantity ?? null,
          pricingSchemaVersion:saved.product.pricingSchemaVersion ?? null,
          marketPrice:saved.product.marketPrice, yourPrice:saved.product.yourPrice,
          onlineBuyPrice:saved.product.onlineBuyPrice,
          onlineItemProfit:saved.product.onlineItemProfit, onlineBoxProfit:saved.product.onlineBoxProfit,
          pickupItemProfit:saved.product.pickupItemProfit, pickupBoxProfit:saved.product.pickupBoxProfit,
          boxDiff:saved.product.boxDiff};
        state.priceHistory[saved.name]=saved.history;
      }
      calcStars(state.products); record.undoneAt=new Date().toISOString();
      const latestBatch=Array.isArray(state.gameSyncBatches) ? state.gameSyncBatches.at(-1) : null;
      if (latestBatch?.batchId === record.batchId) latestBatch.undoneAt=record.undoneAt;
      const suppressed=suppressedSnapshotIds(state.gameSyncMeta);
      if (!suppressed.includes(record.snapshotId)) suppressed.push(record.snapshotId);
      state.gameSyncMeta.suppressedSnapshotIds=suppressed.slice(-512);
      recordActivity("undo",`Undid ${record.productCount} products · ${record.fieldCount} changes`,{batchId:record.batchId});
      persistAndVerifyState(record.batchId, { undo: true }); renderCurrentTab(); onTrackerDataChanged();
    } catch (error) {
      state=before;
      try { if(oldRaw==null)root.localStorage.removeItem(SK);else root.localStorage.setItem(SK,oldRaw); }
      catch (rollbackError) { console.error("Undo rollback could not be persisted",rollbackError); }
      pauseAutoSync(`Undo failed: ${error.message}`); throw error;
    }
  }
  function openReview() {
    if (!lastReview || !(uiState === "connected" || uiState === "baseline" || uiState === "review")) return;
    const modal = root.document.getElementById("gameSyncReviewModal");
    modal.dataset.fingerprint = snapshotIdentity(lastStatus);
    reviewedDiffs = lastReview.diffs.map(d => ({ ...d }));
    const rows = lastReview.diffs.map(d => `<tr><td><input type="checkbox" class="game-sync-diff" data-key="${escapeHtml(d.key)}" checked></td><td>${d.productId}</td><td data-game-localized="name" data-game-product-id="${d.productId}" data-game-fallback="${escapeHtml(d.trackerName)}">${escapeHtml(localizedProduct(d.productId, d.trackerName))}</td><td>${escapeHtml(d.label)}</td><td>${escapeHtml(formatPrice(d.from))}</td><td>${escapeHtml(formatPrice(d.to))}</td><td>${escapeHtml(d.source)}</td><td>${uiText("confirmed")}</td></tr>`).join("");
    const baselineMode=prefs.mode === "auto" && (!state.gameSyncMeta?.baseline || state.gameSyncMeta?.forceBaselineReview);
    baselineReviewOpen = baselineMode;
    const semanticMigration = (state.gameSyncMeta?.pricingSchemaVersion != null &&
      state.gameSyncMeta.pricingSchemaVersion !== PRICE_SEMANTICS_VERSION) ||
      (!!state.gameSyncMeta?.baseline && state.gameSyncMeta.baseline.pricingSchemaVersion !== PRICE_SEMANTICS_VERSION);
    const migrationNotice = priceLabel(
      "Pricing migration: Average Cost now tracks the game's inventory average separately from Supplier unit cost and Market Price. Review every changed value before Auto Sync resumes.");
    const migrationAck = semanticMigration && baselineMode && lastReview.diffs.length === 0;
    root.document.getElementById("gameSyncReviewModalContent").innerHTML =
      `<p style="color:var(--text2);margin:8px 0">${semanticMigration ? `${migrationNotice} ` : ""}${baselineMode ? (lastReview.diffs.length ? uiT("gameSync.reviewAll", { count: lastReview.diffs.length }) : semanticMigration ? uiText("No price differences were found. Confirm this validated snapshot to finish the semantics migration.") : uiText("No changes detected.")) : uiT("gameSync.changesDetected", { count: lastReview.diffs.length })} ${uiT("gameSync.reviewSnapshot", { save: escapeHtml(lastStatus.selectedSave) })}</p>` +
      `<div class="game-sync-table-wrap"><table class="game-sync-table"><thead><tr><th>Select</th><th>ID</th><th>Product</th><th>Field</th><th>Tracker</th><th>Game</th><th>Source</th><th>Mapping</th></tr></thead><tbody>${rows}</tbody></table></div>` +
      `<div class="game-sync-actions"><button class="btn" id="gameSyncSelectAll">Select all</button><button class="btn" id="gameSyncSelectNone">Deselect all</button><button class="btn act" id="gameSyncApplyAllBtn" ${prefs.mode === "read-only" || !lastReview.diffs.length ? "disabled" : ""}>Apply all</button><button class="btn" id="gameSyncApplyBtn" ${prefs.mode === "read-only" || !lastReview.diffs.length ? "disabled" : ""}>Apply selected</button>${migrationAck ? `<button class="btn act" id="gameSyncConfirmMigrationBtn">${priceLabel("Confirm migration & baseline")}</button>` : ""}<button class="btn" id="gameSyncIgnoreBtn">Ignore this snapshot</button><button class="btn" id="gameSyncCloseReviewBtn">Close</button></div><div id="gameSyncReviewError" class="game-sync-note"></div>`;
    root.document.getElementById("gameSyncSelectAll").onclick = () => selectAll(true);
    root.document.getElementById("gameSyncSelectNone").onclick = () => selectAll(false);
    root.document.getElementById("gameSyncApplyAllBtn").onclick = () => { selectAll(true); applySelected(); };
    root.document.getElementById("gameSyncApplyBtn").onclick = applySelected;
    root.document.getElementById("gameSyncConfirmMigrationBtn")?.addEventListener("click", confirmEmptyBaselineReview);
    root.document.getElementById("gameSyncIgnoreBtn").onclick = ignoreSnapshot;
    root.document.getElementById("gameSyncCloseReviewBtn").onclick = () => { baselineReviewOpen=false; closeModal("gameSyncReviewModal"); };
    modal.classList.add("open");
  }
  async function confirmEmptyBaselineReview() {
    const errorEl = root.document.getElementById("gameSyncReviewError");
    if (!baselineReviewOpen || !state.gameSyncMeta?.forceBaselineReview || lastReview?.diffs.length) return;
    const reviewedFingerprint = root.document.getElementById("gameSyncReviewModal").dataset.fingerprint;
    try {
      await refresh(true);
      if (!lastStatus?.connected || snapshotIdentity(lastStatus) !== reviewedFingerprint || lastReview?.diffs.length)
        throw new Error("Game snapshot or tracker changed. Reopen Review Changes.");
      establishBaseline(lastSnapshot, lastReview);
      recordActivity("baseline", "Pricing semantics migration confirmed with no price differences");
      persistAndVerifyState();
      baselineReviewOpen = false; autoPauseReason = ""; uiState = "connected";
      closeModal("gameSyncReviewModal"); render();
    } catch (error) { errorEl.textContent = uiText(error.message || "Could not confirm pricing migration."); }
  }
  function selectAll(checked) {
    root.document.querySelectorAll("#gameSyncReviewModal .game-sync-diff").forEach(box => box.checked = checked);
  }
  function ignoreSnapshot() {
    prefs.ignoredFingerprint = currentFingerprint;
    storePreferences(); closeModal("gameSyncReviewModal"); render();
  }
  function openIssues() {
    if (!lastReview) return;
    const { coverage, issues } = lastReview;
    const rows = lastReview.audit.map(i => `<tr><td>${i.productId ?? "—"}</td><td>${escapeHtml(i.gameMetadata)}</td><td data-game-localized="name" data-game-product-id="${i.productId ?? ""}" data-game-fallback="${escapeHtml(i.trackerCandidate)}">${escapeHtml(localizedProduct(i.productId, i.trackerCandidate))}</td><td data-game-localized="category" data-game-product-id="${i.productId ?? ""}" data-game-fallback="${escapeHtml(i.category)}">${escapeHtml(localizedProduct(i.productId, i.category, "localizedCategory"))}</td><td>${escapeHtml(uiText(i.license))}</td><td>${escapeHtml(uiText(i.status))}</td><td>${escapeHtml(uiText(i.reason))}</td></tr>`).join("");
    root.document.getElementById("gameSyncIssuesModalContent").innerHTML =
      `<p style="color:var(--text2);margin:8px 0">${uiT("gameSync.issuesSummary", { confirmed: coverage.confirmed, tracker: coverage.trackerUnmapped, game: coverage.gameUnmapped, ambiguous: coverage.ambiguous, bakery: coverage.bakeryGameOnly })}</p>` +
      `<div class="game-sync-table-wrap"><table class="game-sync-table"><thead><tr><th>ProductID</th><th>Game name</th><th>Tracker candidate</th><th>Category</th><th>License</th><th>Status</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></div>` +
      `<div class="game-sync-actions"><button class="btn" id="gameSyncExportIssuesBtn">Export Mapping Audit (JSON)</button><button class="btn" id="gameSyncCloseIssuesBtn">Close</button></div>`;
    root.document.getElementById("gameSyncExportIssuesBtn").onclick = exportIssues;
    root.document.getElementById("gameSyncCloseIssuesBtn").onclick = () => closeModal("gameSyncIssuesModal");
    root.document.getElementById("gameSyncIssuesModal").classList.add("open");
  }
  function exportIssues() {
    const data = mappingAuditExport(lastReview);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = root.document.createElement("a");
    a.href = url; a.download = "supermarket-tracker-mapping-audit.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function mappingAuditExport(review) {
    return { schemaVersion: 1, coverage: review.coverage, products: review.audit, issues: review.issues };
  }
  function backupLegacyState(storage, stateKey, backupKey) {
    const original = storage.getItem(stateKey);
    if (original != null && storage.getItem(backupKey) == null)
      storage.setItem(backupKey, original);
  }
  function ensurePreGameSyncBackup() {
    backupLegacyState(root.localStorage, SK, PRE_GAME_SYNC_BACKUP_KEY);
  }
  function runAtomicApply(options) {
    const { trackerState, selected, batchId, selectedSave, snapshotFingerprint, snapshotId,
      source = "game-review-sync", mode = "review", undoRecord, metaMutation,
      update, recalc, persist, afterCommit = () => {}, restore } = options;
    if (mode === "auto" && snapshotId && (processedSnapshotIds(trackerState.gameSyncMeta).includes(snapshotId) ||
        isSuppressedSnapshot(trackerState.gameSyncMeta,snapshotId)))
      return { changeCount: 0, productCount: 0, batchId: null, alreadyProcessed: true };
    const oldState = JSON.parse(JSON.stringify(trackerState));
    const migrationStartedAt = Date.now();
    try {
      const groups = new Map();
      for (const d of selected) {
        if (d.mappingStatus !== "confirmed" || !Number.isSafeInteger(d.productId) ||
            !AUTO_SYNC_FIELDS.has(d.field) || !Number.isFinite(d.to) || d.to < 0)
          throw new Error("Unconfirmed or invalid change cannot be applied");
        const group = groups.get(d.productId) || { productId: d.productId, trackerName: d.trackerName };
        if (group.trackerName !== d.trackerName) throw new Error("Ambiguous ProductID mapping");
        group[d.field] = d.to;
        if (d.averageCostStatus) group.averageCostStatus = d.averageCostStatus;
        if (d.field === "supplierUnitPrice" || d.field === "onlineBuyPrice")
          group.purchaseQuantity = d.purchaseQuantity;
        groups.set(d.productId, group);
      }
      for (const group of groups.values()) {
        const candidates = trackerState.products.filter(p => p.name === group.trackerName);
        if (candidates.length !== 1 || (candidates[0].productId != null && candidates[0].productId !== group.productId))
          throw new Error("Tracker mapping changed or is ambiguous");
        const p = candidates[0];
        const last = (trackerState.priceHistory[p.name] || []).at(-1);
        const discountPct = Number.isFinite(last?.discountPct) ? last.discountPct : 0;
        const updateOptions = { discountPct, source,
            supplierUnitPrice: group.supplierUnitPrice ?? p.supplierUnitPrice,
            purchaseQuantity: group.purchaseQuantity ?? p.gamePurchaseQuantity,
            averageCostStatus: group.averageCostStatus,
            productId: group.productId, batchId, snapshotId, syncMode: mode };
        if (Object.prototype.hasOwnProperty.call(group, "averageCost"))
          updateOptions.averageCost = group.averageCost;
        update(p, group.marketPrice ?? p.marketPrice, group.onlineBuyPrice ?? p.onlineBuyPrice,
          group.yourPrice ?? p.yourPrice, updateOptions);
        p.productId = group.productId;
      }
      const ids = trackerState.products.map(p => p.productId).filter(x => x != null);
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate ProductID after apply");
      trackerState.gameSyncBatches = Array.isArray(trackerState.gameSyncBatches) ? trackerState.gameSyncBatches : [];
      trackerState.gameSyncBatches.push({ batchId, savedAt: Date.now(), selectedSave,
        snapshotFingerprint, snapshotId: snapshotId || snapshotFingerprint,
        changeCount: selected.length, productCount: groups.size, mode });
      trackerState.gameSyncBatches = trackerState.gameSyncBatches.slice(-30);
      trackerState.gameSyncMeta ||= {};
      trackerState.gameSyncMeta.semanticMigrationAt ||= migrationStartedAt;
      trackerState.gameSyncMeta.pricingSchemaVersion = PRICE_SEMANTICS_VERSION;
      if (mode === "auto") {
        trackerState.gameSyncMeta.lastAutoUndo = undoRecord;
        const ids = processedSnapshotIds(trackerState.gameSyncMeta);
        if (snapshotId && !ids.includes(snapshotId)) ids.push(snapshotId);
        trackerState.gameSyncMeta.processedSnapshotIds = ids.slice(-512);
        trackerState.gameSyncMeta.lastProcessedSnapshotId = snapshotId;
      }
      recordActivity(mode === "auto" ? "auto-sync" : "review",
        `${groups.size} products · ${selected.length} changes applied`, { batchId, snapshotId, selectedSave }, trackerState);
      if (metaMutation) metaMutation(trackerState, { batchId, groups, selected });
      recalc();
      if (mode === "auto" && undoRecord) undoRecord.afterProducts = [...groups.values()].map(group => {
        const product=trackerState.products.find(p=>p.name===group.trackerName);
        return { name:group.trackerName, signature:undoProductSignature(product) };
      });
      persist(); afterCommit();
      return { changeCount: selected.length, productCount: groups.size, batchId };
    } catch (error) { restore(oldState); throw error; }
  }
  async function applySelected() {
    const errorEl = root.document.getElementById("gameSyncReviewError");
    const baselineMode=prefs.mode === "auto" && (!state.gameSyncMeta?.baseline || state.gameSyncMeta?.forceBaselineReview);
    if (!(prefs.mode === "review" || baselineMode) || !(uiState === "connected" || uiState === "baseline" || uiState === "review")) return;
    const keys = new Set([...root.document.querySelectorAll("#gameSyncReviewModal .game-sync-diff:checked")].map(e => e.dataset.key));
    if (!keys.size) { errorEl.textContent = "Select at least one change."; return; }
    const reviewedFingerprint = root.document.getElementById("gameSyncReviewModal").dataset.fingerprint;
    const selected = reviewedDiffs.filter(d => keys.has(d.key));
    try {
      await refresh(true); // revalidate helper and snapshot immediately before any mutation
      if (!lastStatus?.connected || snapshotIdentity(lastStatus) !== reviewedFingerprint)
        throw new Error("Game snapshot changed or helper disconnected. Reopen Review Changes.");
      if (selected.length !== keys.size || !(prefs.mode === "review" || baselineMode)) throw new Error("Review list changed. Reopen it.");
      for (const d of selected) {
        if (!lastReview.diffs.some(f => f.key === d.key && f.trackerName === d.trackerName &&
            priceStateEqual(f.from, d.from) && pricesEqual(f.to, d.to)))
          throw new Error("Tracker prices or mapping changed since review. Reopen it.");
      }
      if (baselineMode && selected.length !== lastReview.diffs.length)
        throw new Error("Apply all baseline changes once before Auto Sync can start.");
      for (const id of new Set(selected.map(d => d.productId))) {
        const purchaseDiffs = lastReview.diffs.filter(d => d.productId === id &&
          (d.field === "supplierUnitPrice" || d.field === "onlineBuyPrice"));
        if (purchaseDiffs.length === 2 && purchaseDiffs.some(d => !keys.has(d.key)))
          throw new Error(`Product ${id}: select Supplier unit price and Online box price together.`);
      }
      for (const d of selected) {
        const current = state.products.find(p => p.name === d.trackerName);
        if (!current || (current.productId != null && current.productId !== d.productId) ||
            !priceStateEqual(current[d.field], d.from))
          throw new Error("Tracker prices changed since review. Refresh and review again.");
      }
      ensurePreGameSyncBackup(); // migration backup must succeed before modifying state
      const oldRaw = root.localStorage.getItem(SK);
      const batchId = `game-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      runAtomicApply({ trackerState: state, selected, batchId,
        selectedSave: lastStatus.selectedSave, snapshotFingerprint: currentFingerprint,
        snapshotId: snapshotIdentity(lastStatus), source: "game-review-sync", mode: "review",
        update: updateTrackedProduct, recalc: () => calcStars(state.products),
        persist: () => persistAndVerifyState(batchId),
        metaMutation: baselineMode ? (trackerState) => {
          const snapshotId=snapshotIdentity(lastStatus), ids=processedSnapshotIds(trackerState.gameSyncMeta);
          if (!ids.includes(snapshotId)) ids.push(snapshotId);
          trackerState.gameSyncMeta.processedSnapshotIds=ids.slice(-512);
          trackerState.gameSyncMeta.lastProcessedSnapshotId=snapshotId;
          trackerState.gameSyncMeta.baseline = { selectedSave:lastStatus.selectedSave, snapshotId,
            pricingSchemaVersion: PRICE_SEMANTICS_VERSION,
            gameVersion:lastStatus.gameVersion, productCount:lastStatus.productCount,
            confirmedMappings:lastReview.coverage.confirmed, ambiguousMappings:lastReview.coverage.ambiguous,
            gameUnmapped:lastReview.coverage.gameUnmapped, establishedAt:new Date().toISOString() };
          delete trackerState.gameSyncMeta.hold; delete trackerState.gameSyncMeta.forceBaselineReview;
          recordActivity("baseline","Initial Review baseline applied; Auto Sync enabled",{batchId});
        } : null,
        afterCommit: () => { renderCurrentTab(); onTrackerDataChanged(); closeModal("gameSyncReviewModal"); },
        restore: (oldState) => {
          state = oldState;
        try { if (oldRaw == null) root.localStorage.removeItem(SK); else root.localStorage.setItem(SK, oldRaw); }
        catch (rollbackError) { console.error("Game Sync persistence rollback failed", rollbackError); }
        try { renderCurrentTab(); onTrackerDataChanged(); } catch (renderError) { console.error(renderError); }
        } });
      if (baselineMode) {
        lastReview=buildReview(lastProducts,state.products);
        if (lastReview.diffs.length) throw new Error("Baseline Apply did not produce a clean tracker state.");
        baselineReviewOpen=false; autoPauseReason=""; uiState="connected"; render();
      }
    } catch (e) { errorEl.textContent = uiText(e.message || "Could not apply changes."); }
  }
  function getPreferences() { return { ...prefs, mode: prefs.mode === "auto" ? "review" : prefs.mode }; }
  function restorePreferences(value) { prefs = normalizePreferences(value); if (prefs.mode === "auto") prefs.mode="review"; storePreferences(); render(); }
  function markDataRestored() {
    state.gameSyncMeta ||= {}; state.gameSyncMeta.onboardingDismissedAt=new Date().toISOString();
    root.document?.getElementById("gameSyncMigrationHint")?.remove();
    saveState(); render();
  }
  function showOnboarding() {
    if (root.location?.protocol !== "http:" || state.gameSyncMeta?.onboardingDismissedAt) return;
    const history=Object.values(state.priceHistory || {}).flat();
    if (!state.products.every(p=>p.productId==null) || !history.every(e=>e.isDefault)) return;
    const el=root.document.createElement("p");el.className="game-sync-note";el.id="gameSyncMigrationHint";
    el.innerHTML='Moving from standalone HTML? Its browser storage is separate. Export <b>Backup → Download Backup</b> in the old tracker, then <b>Backup → Restore</b> here.';
    root.document.getElementById("gameSyncPanel")?.appendChild(el);
  }
  function start() { createUi(); loadPreferences(); showOnboarding(); render(); refresh(false); }

  const GameSync = { start, refresh, openReview, openIssues, setMode, onTrackerDataChanged, markDataRestored,
    getPreferences, restorePreferences, ignoreSnapshot, applySelected, undoLastSync, openActivity,
    getProductActiveStatus,
    calculateInventoryProfit,
    getDiagnostics: () => ({ status: lastStatus, review: lastReview, fingerprint: currentFingerprint,
      snapshotId: lastStatus?.snapshotHash ? snapshotIdentity(lastStatus) : null, snapshot: lastSnapshot,
      state: uiState, mode: prefs.mode, pauseReason: autoPauseReason, lastCheckAt }) };
  root.GameSync = GameSync;
  if (typeof module !== "undefined" && module.exports)
    module.exports = { GameSync, GameSyncClient, ApiSchemaError, ApiResponseError,
      validateStatus, validateProducts, validateLicenses, validBooleanField, buildReview, pricesEqual,
      calculateInventoryProfit,
      fingerprint, normalizePreferences, shouldSuppressDiff, backupLegacyState,
      runAtomicApply, mappingAuditExport, validateAutoSyncSnapshot, autoSyncDecision,
      whitelistAutoDiffs, snapshotIdentity, AUTO_SYNC_THRESHOLDS, PRICE_EPSILON };
})(typeof window !== "undefined" ? window : globalThis);
