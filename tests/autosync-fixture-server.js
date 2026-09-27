"use strict";

// Browser acceptance fixture only. It copies a real helper snapshot into RAM,
// then mutates that copy through a loopback-only test endpoint. It never writes
// the selected game save or any helper-owned snapshot.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const port = Number(process.argv[2] || 47832);
const helper = process.env.SMTRACKER_HELPER_URL || "http://127.0.0.1:47831";
let status, snapshot;
let malformedProduct = null;

async function initialize() {
  const [statusResponse, snapshotResponse] = await Promise.all([
    fetch(`${helper}/status`), fetch(`${helper}/snapshot`),
  ]);
  if (!statusResponse.ok || !snapshotResponse.ok) throw new Error("Live helper has no parsed save snapshot");
  status = await statusResponse.json();
  snapshot = await snapshotResponse.json();
  if (!status.connected || snapshot.products?.length !== status.productCount)
    throw new Error("Live helper snapshot failed validation");
  status = structuredClone(status);
  snapshot = structuredClone(snapshot);
}

function json(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 16_384) throw new Error("Test command too large");
  }
  return JSON.parse(data || "{}");
}

function refreshIdentity() {
  const now = new Date().toISOString();
  status.lastSaveWriteTime = now;
  status.lastSuccessfulParse = now;
  status.lastAttempt = now;
  snapshot.saveWriteTimeUtc = now;
  snapshot.parsedAtUtc = now;
  const hashInput = { ...snapshot };
  delete hashInput.snapshotHash;
  snapshot.snapshotHash = crypto.createHash("sha256").update(JSON.stringify(hashInput)).digest("hex");
  status.snapshotHash = snapshot.snapshotHash;
}

function updateFixture(command) {
  if (command.clearMalformed === true && malformedProduct) {
    const product = snapshot.products.find(p => p.productId === malformedProduct.productId);
    if (product) product.marketPrice = malformedProduct.marketPrice;
    malformedProduct = null;
  }
  if (command.selectedSave != null) {
    if (!/^slot_[0-9]+\.es3$/i.test(command.selectedSave)) throw new Error("Invalid fixture slot");
    status.selectedSave = command.selectedSave;
    snapshot.sourceSave = command.selectedSave;
  }
  for (const item of command.changes || []) {
    if (!Number.isSafeInteger(item.productId) || item.productId < 1) throw new Error("Invalid fixture ProductID");
    const product = snapshot.products.find(p => p.productId === item.productId);
    if (!product) throw new Error("Unknown fixture ProductID");
    if (Object.hasOwn(item, "marketPrice")) {
      if (typeof item.marketPrice !== "number" || !Number.isFinite(item.marketPrice) || item.marketPrice < 0)
        throw new Error("Invalid fixture market price");
      product.marketPrice = { value: item.marketPrice, status: "present",
        source: `derived:Pricing[${item.productId}].MarketPrice`,
        derivedFrom: ["supplierUnitPrice", "gameData.optimumProfitRate"] };
    }
    if (item.playerSellPriceStatus === "absent")
      product.playerSellPrice = { value: null, status: "absent", source: null };
    else if (Object.hasOwn(item, "playerSellPrice")) {
      if (typeof item.playerSellPrice !== "number" || !Number.isFinite(item.playerSellPrice) || item.playerSellPrice < 0)
        throw new Error("Invalid fixture sell price");
      product.playerSellPrice = { value: item.playerSellPrice, status: "present",
        source: `Price.value.PricesSetByPlayer[${item.productId}].Price` };
    }
    if (Object.hasOwn(item, "averageCost")) {
      if (typeof item.averageCost !== "number" || !Number.isFinite(item.averageCost) || item.averageCost < 0)
        throw new Error("Invalid fixture average cost");
      product.averageCost = { value: item.averageCost, status: "present",
        source: `Price.value.AverageCosts[${item.productId}].Price` };
    }
  }
  if (command.malformed === "price" && snapshot.products.length && !malformedProduct) {
    malformedProduct = { productId: snapshot.products[0].productId,
      marketPrice: structuredClone(snapshot.products[0].marketPrice) };
    delete snapshot.products[0].marketPrice;
  }
  status.connected = true; status.error = null;
  refreshIdentity();
  return { status, snapshot };
}

async function serve(req, res) {
  if (req.headers.host !== `127.0.0.1:${port}`) return json(res, 403, { error: "loopback host required" });
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === "POST" && url.pathname === "/__test__/update") {
    try { return json(res, 200, updateFixture(await readBody(req))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
  if (url.pathname === "/health") return json(res, 200, { schemaVersion: 3, status: "ok" });
  if (url.pathname === "/status") return json(res, 200, status);
  if (url.pathname === "/snapshot" || url.pathname === "/products") return json(res, 200, snapshot);
  if (url.pathname === "/locales") return json(res, 200, { schemaVersion: 1,
    available: ["en", "ru-RU"], detected: ["en", "ru-RU"], gameVersion: "browser-fixture",
    bundleFingerprint: "sha256:browser-fixture", warning: null });
  if (url.pathname === "/localization/ru-RU") return json(res, 200, { schemaVersion: 1,
    requestedLocale: "ru-RU", locale: "ru-RU", source: "game-localization", gameVersion: "browser-fixture",
    bundleFingerprint: "sha256:browser-fixture", available: true, fallbackLocale: null, warning: null,
    products: {
      "33": { productId: 33, canonicalCategory: "Cereal", canonicalBrand: "Chokipik",
        localizedCategory: "Хлопья", localizedBrand: null, localizedLabel: "Хлопья",
        displayName: "Хлопья - Chokipik", source: "game-localization", key: "Products:_cereal" },
      "70": { productId: 70, canonicalCategory: "Sliced Bread", canonicalBrand: "Ron's",
        localizedCategory: "Нарезанный хлеб", localizedBrand: null, localizedLabel: "Нарезанный хлеб",
        displayName: "Нарезанный хлеб - Ron's", source: "game-localization", key: "Products:_slicedBread" },
    } });
  if (url.pathname === "/licenses") return json(res, 200, { schemaVersion: 3,
    unlockedLicenses: snapshot.unlockedLicenses || [], activeLicenses: snapshot.activeLicenses || [] });
  const files = new Map([
    ["/", ["supermarketSimulator-tracker_v2_9.html", "text/html; charset=utf-8"]],
    ["/tracker", ["supermarketSimulator-tracker_v2_9.html", "text/html; charset=utf-8"]],
    ["/src/game-sync.js", ["src/game-sync.js", "text/javascript; charset=utf-8"]],
    ["/src/game-localization.js", ["src/game-localization.js", "text/javascript; charset=utf-8"]],
    ["/src/ui-messages.js", ["src/ui-messages.js", "text/javascript; charset=utf-8"]],
    ["/src/ui-localization.js", ["src/ui-localization.js", "text/javascript; charset=utf-8"]],
    ["/src/profit-threshold.js", ["src/profit-threshold.js", "text/javascript; charset=utf-8"]],
    ["/mapping-audit", ["data/mapping-audit.json", "application/json; charset=utf-8"]],
  ]);
  const entry = files.get(url.pathname);
  if (!entry) return json(res, 404, { error: "not found" });
  const bytes = fs.readFileSync(path.join(root, entry[0]));
  res.writeHead(200, { "Content-Type": entry[1], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (req.method === "HEAD") return res.end();
  res.end(bytes);
}

initialize().then(() => {
  const server = http.createServer((req, res) => { void serve(req, res); });
  server.listen(port, "127.0.0.1", () => console.log(`In-memory Auto Sync fixture on 127.0.0.1:${port}; game save remains untouched`));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}).catch(error => { console.error(error.message); process.exitCode = 1; });
