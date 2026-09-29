using System.Text.Json;
using SupermarketTrackerSync;

int passed = 0, failed = 0;
async Task Check(string name, Func<Task> test)
{
    try { await test(); Console.WriteLine("PASS " + name); passed++; }
    catch (Exception ex) { Console.WriteLine("FAIL " + name + ": " + ex); failed++; }
}
void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
var parser = new Es3SaveParser();
var emptyMap = new ProductMappingProvider(Array.Empty<GameProduct>());
SaveSnapshot Parse(string text) => parser.Parse(text, DateTimeOffset.UtcNow, emptyMap);
string Fixture(string rows = "{\"ProductID\":33,\"Price\":4.116,\"DiscountRate\":0}",
    string player = "{\"ProductID\":33,\"Price\":9.05}", string average = "{\"ProductID\":33,\"Price\":4.092703}",
    string? licenseProductsDatas = null) =>
    "{\"Unknown\":{\"value\":{62:12,\"literal\":\"{7:8}\"}}," +
    "\"Progression\":{\"value\":{\"GameVersion\":\"v1.6.0(223)\",\"UnlockedLicenses\":[21,22],\"ActiveLicenses\":[21]" +
        (licenseProductsDatas is null ? "" : ",\"LicenseProductsDatas\":" + licenseProductsDatas) + "}}," +
    "\"Price\":{\"value\":{\"PricingDatas\":[" + rows + "],\"PricesSetByPlayer\":[" + player + "],\"AverageCosts\":[" + average + "]}}}";
string LocalizationFixture(string gameDataDirectory, string buildId = "fixture-build")
{
    var aa = Path.Combine(gameDataDirectory, "StreamingAssets", "aa"); Directory.CreateDirectory(aa);
    var bytes = System.Text.Encoding.UTF8.GetBytes("official localization fixture");
    File.WriteAllBytes(Path.Combine(aa, "localization-fixture.bundle"), bytes);
    var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
    return JsonSerializer.Serialize(new {
        SchemaVersion = 1, Source = "game-localization",
        Game = new { Name = "Supermarket Simulator", SteamBuildId = buildId, GameVersion = "fixture-version" },
        Cache = new { Fingerprint = "sha256:" + hash, BundleFiles = new[] { new {
            Name = "localization-fixture.bundle", Length = bytes.Length, LastWriteTimeUtc = "fixture", Sha256 = hash } },
            ProductAssetFiles = Array.Empty<object>() },
        DetectedLocales = new[] { "en", "ru-RU" }, AvailableLocales = new[] { "en", "ru-RU" },
        Tables = new { SharedTableCount = 31, SharedKeyCount = 1039,
            LocaleTableCounts = new Dictionary<string, int> { ["en"] = 31, ["ru-RU"] = 31 }, ProductRelatedKeys = 188 },
        Coverage = new { ConfirmedProducts = 292, LocalizedProductLabels = 292,
            CategoryLocalized = 184, BrandLocalized = 0, FallbackEnglish = 0, GameOnlyBakeryBaked = 15, Ambiguous = 2 },
        Products = new[] { new {
            ProductId = 33, AssetName = "33_Cereal_Chokipik",
            Canonical = new { Category = "Cereal", Brand = "Chokipik", DisplayName = "Cereal - Chokipik" },
            Localization = new { Table = "Products", Key = "_cereal", Id = 106258866176L,
                English = "Cereal", Russian = "Хлопья", Source = "shared-localization-key",
                EnglishDisplayName = "Cereal - Chokipik", RussianDisplayName = "Хлопья - Chokipik" },
            MappingStatus = "confirmed-exact" } }
    });
}

await Check("tolerant numeric keys in unknown object", () => {
    var s = Parse(Fixture()); Assert(s.Products.Count == 1 && s.Products[0].ProductId == 33, "ProductID"); return Task.CompletedTask; });
await Check("real-shaped price and licenses", () => {
    var s = Parse(Fixture()); Assert(s.GameVersion == "v1.6.0(223)" && s.UnlockedLicenses.SequenceEqual(new[]{21,22}), "progression");
    Assert(s.Products[0].SupplierUnitPrice.Value == 4.116m && s.Products[0].MarketPrice.Status == "absent" &&
        s.Products[0].DiscountRate.Value == 0m, "price"); return Task.CompletedTask; });
await Check("active product list comes from LicenseProductsDatas and maps through game license IDs", () => {
    var ids = new[] { 24, 33, 39, 55, 62, 66, 70, 83, 84, 85, 147, 151 };
    var rows = string.Join(',', ids.Select(id => $"{{\"ProductID\":{id},\"Price\":1}}"));
    var licenseData = "[{\"LicenseID\":21,\"DisabledProductIDs\":[85,83,84]}," +
        "{\"LicenseID\":22,\"DisabledProductIDs\":[62,39]}]";
    var map = ProductMappingProvider.LoadBuiltIn();
    var products = parser.Parse(Fixture(rows: rows, player: "", average: "", licenseProductsDatas: licenseData),
        DateTimeOffset.UtcNow, map).Products;
    foreach (var id in new[] { 24, 33, 55, 66, 70, 147, 151 })
        Assert(products.Single(p => p.ProductId == id).ActiveInProductList is { Value: true, Status: "present" }, $"active ID {id}");
    foreach (var id in new[] { 39, 62, 83, 84, 85 })
        Assert(products.Single(p => p.ProductId == id).ActiveInProductList is { Value: false, Status: "present" }, $"inactive ID {id}");
    Assert(products.Single(p => p.ProductId == 33).ActiveInProductList.Source ==
        "Progression.value.LicenseProductsDatas[*].DisabledProductIDs", "status source");
    var noLicenseState = parser.Parse(Fixture(licenseProductsDatas: "[]"), DateTimeOffset.UtcNow, map)
        .Products.Single().ActiveInProductList;
    Assert(noLicenseState is { Value: null, Status: "absent" }, "missing license state stays unknown");
    var unknown = Parse(Fixture()).Products[0].ActiveInProductList;
    Assert(unknown is { Value: null, Status: "absent" }, "missing license data stays unknown");
    var malformed = Parse(Fixture(licenseProductsDatas: "{}")).Products[0].ActiveInProductList;
    Assert(malformed is { Value: null, Status: "invalid" }, "malformed license data stays unknown");
    return Task.CompletedTask; });
await Check("ProductID 33 market, supplier, raw box and sparse source", () => {
    var p = parser.Parse(Fixture(), DateTimeOffset.UtcNow, ProductMappingProvider.LoadBuiltIn()).Products[0];
    Assert(p.SupplierUnitPrice.Value == 4.116m && p.SupplierUnitPrice.Source == "Price.value.PricingDatas[33].Price", "supplier source");
    Assert(p.PurchaseQuantity.Value == 12m && p.SupplierBoxPrice.Value == 49.392m, "raw box");
    Assert(p.MarketPrice.Value == 8.23m && p.MarketPrice.Source == "derived:Pricing[33].MarketPrice", "game market derivation");
    Assert(p.PlayerSellPrice.Value == 9.05m && p.PickupBuyPrice.Status == "absent", "sell/pickup");
    var supplier = p.SupplierUnitPrice.Value ?? throw new Exception("supplier missing");
    var box = p.SupplierBoxPrice.Value ?? throw new Exception("box missing");
    var market = p.MarketPrice.Value ?? throw new Exception("market missing");
    Assert(9.05m - supplier == 4.934m && 9.05m * 12 - box == 59.208m, "profit math");
    Assert(Math.Abs((double)((9.05m - market) / market * 100m) - 9.96) < .01, "market delta");
    Assert(Math.Abs((double)((9.05m - supplier) / supplier * 100m) - 119.87) < .01, "cost markup");
    return Task.CompletedTask; });
await Check("ProductID 128 Rice Basmati keeps supplier, Average Cost, market and sell prices distinct", () => {
    var riceSave = Fixture(
        rows: "{\"ProductID\":128,\"Price\":3.39,\"DiscountRate\":0}",
        player: "{\"ProductID\":128,\"Price\":6.52,\"DiscountRate\":0}",
        average: "{\"ProductID\":128,\"Price\":3.99999833,\"DiscountRate\":0}");
    var p = parser.Parse(riceSave, DateTimeOffset.UtcNow, ProductMappingProvider.LoadBuiltIn()).Products.Single();
    var riceSupplier = p.SupplierUnitPrice.Value ?? throw new Exception("supplier missing");
    var riceBox = p.SupplierBoxPrice.Value ?? throw new Exception("box missing");
    var riceAverage = p.AverageCost.Value ?? throw new Exception("average cost missing");
    var riceMarket = p.MarketPrice.Value ?? throw new Exception("market missing");
    var riceSell = p.PlayerSellPrice.Value ?? throw new Exception("sell price missing");
    var riceQuantity = p.PurchaseQuantity.Value ?? throw new Exception("purchase quantity missing");
    Assert(p.GameData?.TrackerKey == "Rice Basmati - Lustupacru", "confirmed ProductID mapping");
    Assert(riceSupplier == 3.39m && p.SupplierUnitPrice.Source == "Price.value.PricingDatas[128].Price", "supplier source");
    Assert(riceQuantity == 10m && riceBox == 33.90m, "supplier box derivation");
    Assert(riceAverage == 3.99999833m && p.AverageCost.Source == "Price.value.AverageCosts[128].Price", "AverageCosts source and precision");
    Assert(riceMarket == 5.93m && p.MarketPrice.Source == "derived:Pricing[128].MarketPrice", "ProductSO-specific market derivation");
    Assert(riceSell == 6.52m && p.PlayerSellPrice.Source == "Price.value.PricesSetByPlayer[128].Price", "player sell source");
    Assert(riceSell - riceAverage == 2.52000167m, "current inventory profit per item");
    Assert(riceSell - riceSupplier == 3.13m, "new purchase profit per item");
    Assert(riceSell * riceQuantity - riceBox == 31.30m, "new purchase profit per box");
    Assert(Math.Abs((double)((riceSell - riceMarket) / riceMarket * 100m) - 9.9494) < .001, "market deviation uses Market Price");
    return Task.CompletedTask; });
await Check("13 products across ordinary, weighted, license and DLC classes retain separate price fields", () => {
    var ids = new[] { 1, 33, 63, 90, 128, 165, 175, 196, 206, 229, 238, 260, 273 };
    var pricingMap = ProductMappingProvider.LoadBuiltIn();
    var rows = string.Join(',', ids.Select((id, i) => {
        var cost = (1.25m + i * 0.1m).ToString(System.Globalization.CultureInfo.InvariantCulture);
        return $"{{\"ProductID\":{id},\"Price\":{cost},\"DiscountRate\":0}}";
    }));
    var players = string.Join(',', ids.Select((id, i) => {
        var sell = (3.25m + i * 0.1m).ToString(System.Globalization.CultureInfo.InvariantCulture);
        return $"{{\"ProductID\":{id},\"Price\":{sell},\"DiscountRate\":0}}";
    }));
    var averages = string.Join(',', ids.Select((id, i) => {
        var avg = (2.015678m + i * 0.1m).ToString(System.Globalization.CultureInfo.InvariantCulture);
        return $"{{\"ProductID\":{id},\"Price\":{avg},\"DiscountRate\":0}}";
    }));
    var products = parser.Parse(Fixture(rows, players, averages), DateTimeOffset.UtcNow, pricingMap).Products;
    Assert(products.Count == ids.Length, "all fixture products returned");
    foreach (var p in products) {
        var sourceData = pricingMap.FindPricing(p.ProductId)!;
        Assert(p.SupplierUnitPrice.Status == "present" && p.SupplierUnitPrice.Source == $"Price.value.PricingDatas[{p.ProductId}].Price", $"supplier {p.ProductId}");
        Assert(p.SupplierBoxPrice.Status == "present" && p.SupplierBoxPrice.Value == p.SupplierUnitPrice.Value * sourceData.PurchaseQuantity, $"box {p.ProductId}");
        Assert(p.AverageCost.Status == "present" && p.AverageCost.Source == $"Price.value.AverageCosts[{p.ProductId}].Price", $"average {p.ProductId}");
        Assert(p.MarketPrice.Status == "present" && p.MarketPrice.Source == $"derived:Pricing[{p.ProductId}].MarketPrice", $"market {p.ProductId}");
        Assert(p.PlayerSellPrice.Status == "present" && p.PlayerSellPrice.Source == $"Price.value.PricesSetByPlayer[{p.ProductId}].Price", $"sell {p.ProductId}");
    }
    Assert(products.Any(p => p.ProductId == 165 && p.GameData?.ProductType == "weighted-produce"), "weighted produce included");
    Assert(products.Any(p => p.ProductId == 196 && p.GameData?.Dlc == "Clothing"), "DLC product included");
    Assert(products.Any(p => p.ProductId == 273 && p.GameData?.Dlc == "Bakery"), "bakery DLC product included");
    Assert(products.Select(p => p.PurchaseQuantity.Value).Distinct().Count() > 3, "different package quantities included");
    return Task.CompletedTask; });
await Check("309 ProductID fixture", () => {
    var rows = string.Join(',', Enumerable.Range(1, 311).Where(x => x is not 143 and not 170)
        .Select(x => $"{{\"ProductID\":{x},\"Price\":1.5,\"DiscountRate\":0}}"));
    var s = Parse(Fixture(rows, "", "")); Assert(s.Products.Count == 309 && s.Products.Select(x => x.ProductId).Distinct().Count() == 309, "count"); return Task.CompletedTask; });
await Check("sparse player price remains absent", () => {
    var s = Parse(Fixture(player:"", average:"")); Assert(s.Products[0].PlayerSellPrice.Value is null && s.Products[0].PlayerSellPrice.Status == "absent", "null semantics"); return Task.CompletedTask; });
await Check("AverageCosts not purchase prices", () => {
    var p = Parse(Fixture()).Products[0]; Assert(p.AverageCost.Value == 4.092703m && p.OnlineBuyPrice.Value is null && p.PickupBuyPrice.Value is null, "cost semantics"); return Task.CompletedTask; });
await Check("invalid numeric field distinct from absent", () => {
    var p = Parse(Fixture(rows:"{\"ProductID\":33,\"Price\":\"broken\"}", player:"", average:"")).Products[0];
    Assert(p.SupplierUnitPrice.Status == "invalid" && p.MarketPrice.Status == "absent" && p.PlayerSellPrice.Status == "absent", "statuses"); return Task.CompletedTask; });
await Check("malformed/truncated save rejected", () => {
    try { Parse(Fixture()[..^5]); throw new Exception("not rejected"); } catch (JsonException) { } return Task.CompletedTask; });
await Check("duplicate ProductID rejected", () => {
    var row = "{\"ProductID\":33,\"Price\":1}";
    try { Parse(Fixture(rows:row+","+row, player:"", average:"")); throw new Exception("not rejected"); } catch (JsonException) { } return Task.CompletedTask; });
await Check("mapping ProductID and unknown ID", () => {
    var map = new ProductMappingProvider(new[]{new GameProduct(33,"33_Cereal_Chokipik","Cereal - Chokipik","mapped")});
    var s = parser.Parse(Fixture(), DateTimeOffset.UtcNow, map);
    Assert(s.Products[0].GameData?.TrackerKey == "Cereal - Chokipik" && map.Find(999) is null, "mapping"); return Task.CompletedTask; });
await Check("ambiguous and duplicate mapping rejected", () => {
    try { new ProductMappingProvider(new[]{new GameProduct(1,"a","key","mapped"),new GameProduct(2,"b","key","mapped")}); throw new Exception("ambiguous accepted"); } catch (InvalidDataException) { }
    try { new ProductMappingProvider(new[]{new GameProduct(1,"a",null,"unmapped"),new GameProduct(1,"b",null,"unmapped")}); throw new Exception("duplicate accepted"); } catch (InvalidDataException) { }
    return Task.CompletedTask; });
await Check("API camelCase serialization and null", () => {
    string json = JsonSerializer.Serialize(Parse(Fixture(player:"",average:"")), ApiJson.Options);
    Assert(json.Contains("\"schemaVersion\":3") && json.Contains("\"activeInProductList\":{\"value\":null,\"status\":\"absent\"" ) &&
        json.Contains("\"playerSellPrice\":{\"value\":null,\"status\":\"absent\""), "serialization"); return Task.CompletedTask; });
await Check("localization API resolves ProductID 33 with UTF-8 Russian label and stable canonical identity", () => {
    var root = Path.Combine(Path.GetTempPath(), "smtracker-loc-valid-" + Guid.NewGuid().ToString("N"));
    var data = Path.Combine(root, "Game_Data"); Directory.CreateDirectory(data);
    try {
        var install = new GameInstall(root, data, "fixture-build"); var discovery = new MutableGameInstallDiscovery(install);
        using var catalog = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(LocalizationFixture(data)));
        var provider = new GameLocalizationProvider(catalog, discovery);
        var result = provider.GetLocalization("ru-RU"); var p = result.Products["33"];
        var json = JsonSerializer.Serialize(result, ApiJson.Options);
        Assert(provider.IsAvailable && provider.GetLocales().Available.SequenceEqual(new[]{"en","ru-RU"}), "locale discovery");
        Assert(p.ProductId == 33 && p.CanonicalCategory == "Cereal" && p.CanonicalBrand == "Chokipik", "canonical identity");
        Assert(p.LocalizedCategory == "Хлопья" && p.LocalizedLabel == "Хлопья" && p.DisplayName == "Хлопья - Chokipik" && p.LocalizedBrand is null, "game label and untranslated inline brand");
        Assert(json.Contains("Хлопья", StringComparison.Ordinal) && json.Contains("Хлопья - Chokipik", StringComparison.Ordinal), "API JSON must contain readable UTF-8");
        Assert(!provider.Refresh() && provider.IsAvailable, "unchanged bundle content skips full validation");
        var unsupported = provider.GetLocalization("fr-FR");
        Assert(!unsupported.Available && unsupported.FallbackLocale == "en" && unsupported.Source == "canonical-fallback", "unsupported locale falls back to canonical English");
    } finally { Directory.Delete(root, true); }
    return Task.CompletedTask;
});
await Check("game update or bundle fingerprint mismatch falls back safely", () => {
    var root = Path.Combine(Path.GetTempPath(), "smtracker-loc-change-" + Guid.NewGuid().ToString("N"));
    var data = Path.Combine(root, "Game_Data"); Directory.CreateDirectory(data);
    try {
        var install = new GameInstall(root, data, "fixture-build"); var discovery = new MutableGameInstallDiscovery(install);
        using var catalog = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(LocalizationFixture(data)));
        var provider = new GameLocalizationProvider(catalog, discovery);
        discovery.Current = install with { SteamBuildId = "updated-build" };
        Assert(provider.Refresh() && !provider.IsAvailable, "changed Steam build is reported as not current");
        var updatedBuild = provider.GetLocalization("ru-RU");
        Assert(updatedBuild.Locale == "ru-RU" && updatedBuild.Source == "bundled-fallback"
            && updatedBuild.Products["33"].DisplayName == "Хлопья - Chokipik", "changed Steam build keeps bundled Russian labels");
    } finally { Directory.Delete(root, true); }
    var bundleRoot = Path.Combine(Path.GetTempPath(), "smtracker-loc-bundle-" + Guid.NewGuid().ToString("N"));
    var bundleData = Path.Combine(bundleRoot, "Game_Data"); Directory.CreateDirectory(bundleData);
    try {
        var install = new GameInstall(bundleRoot, bundleData, "fixture-build"); var discovery = new MutableGameInstallDiscovery(install);
        using var catalog = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(LocalizationFixture(bundleData)));
        var provider = new GameLocalizationProvider(catalog, discovery);
        var bundle = Path.Combine(bundleData, "StreamingAssets", "aa", "localization-fixture.bundle");
        var originalWrite = File.GetLastWriteTimeUtc(bundle); var originalLength = new FileInfo(bundle).Length;
        File.WriteAllText(bundle, "tampered localization fixture");
        File.SetLastWriteTimeUtc(bundle, originalWrite);
        Assert(new FileInfo(bundle).Length == originalLength, "fixture must preserve length");
        Assert(provider.Refresh() && !provider.IsAvailable, "same-stamp bundle content change is reported as not current");
        var bundled = provider.GetLocalization("ru-RU");
        Assert(bundled.Locale == "ru-RU" && bundled.Source == "bundled-fallback"
            && bundled.Products["33"].DisplayName == "Хлопья - Chokipik", "changed bundle keeps bundled Russian labels");
    } finally { Directory.Delete(bundleRoot, true); }
    return Task.CompletedTask;
});
await Check("missing Steam install and discovery failures keep English fallback usable", () => {
    var missing = new GameLocalizationProvider(null, new MutableGameInstallDiscovery(null));
    Assert(!missing.IsAvailable && missing.GetLocales().Available.SequenceEqual(new[]{"en"}), "missing install");
    var failed = new GameLocalizationProvider(null, new MutableGameInstallDiscovery(null, new IOException("fixture")));
    Assert(!failed.IsAvailable && failed.GetLocalization("ru-RU").Source == "canonical-fallback", "discovery exception fallback");
    var malformed = new GameLocalizationProvider(new MemoryStream(System.Text.Encoding.UTF8.GetBytes("{broken")),
        new MutableGameInstallDiscovery(null));
    Assert(!malformed.IsAvailable && malformed.GetLocales().Available.SequenceEqual(new[]{"en"}), "malformed catalog fallback");
    return Task.CompletedTask;
});
await Check("generated ProductSO sidecar and bakery exception", () => {
    var path = Path.Combine(Directory.GetCurrentDirectory(),"data","product-map.json");
    var map = ProductMappingProvider.Load(path);
    Assert(map.Find(33)?.TrackerKey == "Cereal - Chokipik" && map.Find(273)?.TrackerKey == "Bagel Frozen"
        && map.Find(274)?.MappingStatus == "unmapped" && map.Find(165)?.ProductType == "weighted-produce", "sidecar");
    return Task.CompletedTask; });
await Check("built-in mapping does not require adjacent files", () => {
    var map = ProductMappingProvider.LoadBuiltIn();
    Assert(Enumerable.Range(1,311).Count(id => map.Find(id)?.MappingStatus == "mapped") == 292, "coverage");
    Assert(map.Find(165)?.TrackerKey == "Apple" && map.Find(4)?.AuditStatus == "ambiguous", "identities");
    return Task.CompletedTask; });
await Check("embedded tracker and adapter are served from exact resources", () => {
    var root = TrackerWebAssets.Get("/"); var tracker = TrackerWebAssets.Get("/tracker");
    Assert(root is not null && tracker is not null && root.Value.Bytes.SequenceEqual(tracker.Value.Bytes), "same HTML");
    Assert(System.Text.Encoding.UTF8.GetString(root!.Value.Bytes).Contains("src/game-sync.js"), "adapter link");
    Assert(TrackerWebAssets.Get("/src/game-sync.js")?.ContentType.StartsWith("text/javascript") == true, "script");
    Assert(TrackerWebAssets.Get("/src/game-localization.js")?.ContentType.StartsWith("text/javascript") == true, "localization script");
    Assert(TrackerWebAssets.Get("/src/ui-messages.js")?.ContentType.StartsWith("text/javascript") == true, "UI messages script");
    Assert(TrackerWebAssets.Get("/src/ui-localization.js")?.ContentType.StartsWith("text/javascript") == true, "UI localization script");
    Assert(TrackerWebAssets.Get("/src/profit-threshold.js")?.ContentType.StartsWith("text/javascript") == true, "profit threshold script");
    return Task.CompletedTask; });
await Check("arbitrary files and traversal cannot resolve", () => {
    foreach (var path in new[]{"/../Program.cs","/%2e%2e/Program.cs","/C:/Windows/win.ini","/data/product-map.json","/logs/helper.log","//tracker","/tracker/anything"})
        Assert(TrackerWebAssets.Get(path) is null, path);
    return Task.CompletedTask; });
await Check("open CLI and secure hosted default", () => {
    var options = CliOptions.Parse(new[]{"--open","--port","47839"});
    Assert(options.Open && options.Port == 47839 && !options.AllowFileOrigin, "options");
    Assert(CliOptions.Parse(Array.Empty<string>()).Open, "double-click opens tracker by default");
    Assert(!CliOptions.Parse(new[]{"--no-open"}).Open, "no-open suppresses browser launch");
    Assert(CliOptions.Parse(new[]{"--allow-file-origin"}).AllowFileOrigin,"optional file mode");
    return Task.CompletedTask; });
await Check("live-test and version CLI; embedded mapping version", () => {
    Assert(CliOptions.Parse(new[]{"--live-test","--no-open"}).LiveTest, "live-test option");
    Assert(CliOptions.Parse(new[]{"--version"}).Version, "version option");
    Assert(BuildInfo.ApiSchemaVersion == 3 && BuildInfo.TrackerVersion == "2.9", "versions");
    var path = Path.Combine(Directory.GetCurrentDirectory(),"data","product-map.json");
    var expected = "sha256:" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path)))[..12].ToLowerInvariant();
    Assert(BuildInfo.MappingDataVersion == expected, "mapping resource fingerprint");
    var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    Assert(BuildInfo.LogPath.StartsWith(localData + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "LocalAppData log location");
    return Task.CompletedTask; });
await Check("mapping audit serializes and conflicts are rejected", () => {
    var audit = TrackerWebAssets.Get("/mapping-audit"); Assert(audit is not null,"audit resource");
    using var doc=JsonDocument.Parse(audit!.Value.Bytes);
    Assert(doc.RootElement.GetProperty("gameProducts").GetArrayLength()==309,"audit products");
    try { new ProductMappingProvider(new[]{new GameProduct(4,"beer","x","mapped") { AuditStatus="ambiguous" }}); throw new Exception("unsafe status accepted"); }
    catch (InvalidDataException) { }
    return Task.CompletedTask; });

var temp = Path.Combine(Path.GetTempPath(), "smtracker-phase-b-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(temp);
try
{
    await Check("newest active slot selected; backup excluded", () => {
        var older = Path.Combine(temp,"slot_0.es3"); var newer = Path.Combine(temp,"slot_1.es3"); var backup = Path.Combine(temp,"slot_1_bk_latest.es3");
        File.WriteAllText(older, Fixture()); File.WriteAllText(newer, Fixture()); File.WriteAllText(backup, Fixture());
        File.SetLastWriteTimeUtc(older, DateTime.UtcNow.AddMinutes(-3));
        File.SetLastWriteTimeUtc(newer, DateTime.UtcNow.AddMinutes(-2));
        File.SetLastWriteTimeUtc(backup, DateTime.UtcNow.AddMinutes(-1));
        var d = new SaveDiscoveryService(temp); var selection = d.Discover();
        Assert(selection.Selected?.Name == "slot_1.es3" && selection.Slots.Count == 3
            && selection.Reason.Contains("proposed"), "newest active slot");
        Assert(d.Discover(older).Selected?.Name == "slot_0.es3", "explicit override");
        return Task.CompletedTask; });
    await Check("locked save retry", async () => {
        var path = Path.Combine(temp,"locked.es3"); File.WriteAllText(path,Fixture());
        var lockStream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        var release = Task.Run(async () => { await Task.Delay(650); lockStream.Dispose(); });
        var diagnostic = new List<string>();
        var (text, _, _) = await new SaveReader().ReadStableAsync(path,CancellationToken.None, diagnostic.Add);
        await release; Assert(text.Contains("PricingDatas") && diagnostic.Any(s => s.Contains("Read attempt"))
            && diagnostic.Any(s => s.Contains("Save stable")), "lock retry diagnostics"); });
    await Check("newer save during parse is not published", async () => {
        var path = Path.Combine(temp,"rapid.es3"); File.WriteAllText(path,Fixture());
        var replacement = Fixture(rows:"{\"ProductID\":33,\"Price\":5.25,\"DiscountRate\":0}");
        var mutator = new MutatingParser(parser,path,replacement);
        var service = new SnapshotService(new SaveDiscoveryService(),new SaveReader(),mutator,emptyMap,
            new RollingLog(Path.Combine(temp,"rapid.log")),path);
        await service.RefreshAsync();
        Assert(service.Snapshot is null && !service.Status.Connected, "stale parse was published");
        await service.RefreshAsync();
        Assert(service.Status.Connected && service.Snapshot?.Products[0].SupplierUnitPrice.Value == 5.25m, "newest save did not win");
    });
    await Check("changed length with unchanged timestamp is not published", async () => {
        var path = Path.Combine(temp,"same-time.es3"); File.WriteAllText(path,Fixture());
        var replacement = Fixture(rows:"{\"ProductID\":33,\"Price\":5.25,\"DiscountRate\":0}");
        var mutator = new MutatingParser(parser,path,replacement,preserveTimestamp:true);
        var service = new SnapshotService(new SaveDiscoveryService(),new SaveReader(),mutator,emptyMap,
            new RollingLog(Path.Combine(temp,"same-time.log")),path);
        await service.RefreshAsync();
        Assert(service.Snapshot is null && !service.Status.Connected, "same-time stale parse was published");
        await service.RefreshAsync();
        Assert(service.Status.Connected && service.Snapshot?.Products[0].SupplierUnitPrice.Value == 5.25m, "same-time replacement was not read");
    });
    await Check("live diagnostics and log rotation", async () => {
        var path = Path.Combine(temp,"live.log");
        var log = new RollingLog(path,liveTest:true);
        log.Live("diagnostic marker");
        Assert(File.ReadAllText(path).Contains("[LIVE] diagnostic marker"), "live diagnostic line");
        File.WriteAllText(path,new string('x',1_000_001));
        log.Info("rotation marker");
        Assert(File.Exists(path+".1") && File.ReadAllText(path).Contains("rotation marker"), "rotation");
        await Task.CompletedTask;
    });
    await Check("partial save preserves last good snapshot", async () => {
        var path = Path.Combine(temp,"partial.es3"); File.WriteAllText(path,Fixture());
        var service = new SnapshotService(new SaveDiscoveryService(),new SaveReader(),parser,emptyMap,
            new RollingLog(Path.Combine(temp,"test.log")),path);
        await service.RefreshAsync(); var good = service.Snapshot;
        File.WriteAllText(path, "{\"Price\":");
        File.SetLastWriteTimeUtc(path,DateTime.UtcNow.AddSeconds(2));
        await service.RefreshAsync();
        Assert(ReferenceEquals(good,service.Snapshot) && service.Status.Error is not null && !service.Status.Connected, "retention"); });
    await Check("watcher/poll publishes new save snapshot", async () => {
        var watchDir = Path.Combine(temp,"watch"); Directory.CreateDirectory(watchDir);
        var path = Path.Combine(watchDir,"slot_0.es3"); File.WriteAllText(path,Fixture());
        var discovery = new SaveDiscoveryService(watchDir);
        var liveLog = new RollingLog(Path.Combine(temp,"watch.log"),liveTest:true);
        var service = new SnapshotService(discovery,new SaveReader(),parser,emptyMap,liveLog);
        using var watcher = new SaveWatcherService(service,liveLog);
        await watcher.StartAsync(CancellationToken.None);
        try {
            var until = DateTime.UtcNow.AddSeconds(8);
            while (service.Snapshot is null && DateTime.UtcNow < until) await Task.Delay(100);
            Assert(service.Snapshot?.Products[0].SupplierUnitPrice.Value == 4.116m,"first snapshot");
            File.WriteAllText(path,Fixture(rows:"{\"ProductID\":33,\"Price\":5.25,\"DiscountRate\":0}"));
            File.SetLastWriteTimeUtc(path,DateTime.UtcNow.AddSeconds(3));
            until = DateTime.UtcNow.AddSeconds(8);
            while (service.Snapshot?.Products[0].SupplierUnitPrice.Value != 5.25m && DateTime.UtcNow < until) await Task.Delay(100);
            Assert(service.Snapshot?.Products[0].SupplierUnitPrice.Value == 5.25m,"watch refresh");
            Assert(File.ReadAllText(Path.Combine(temp,"watch.log")).Contains("snapshotId=slot_0.es3|"), "snapshot diagnostic");
        } finally { await watcher.StopAsync(CancellationToken.None); }
    });
}
finally
{
    if (Path.GetFullPath(temp).StartsWith(Path.GetFullPath(Path.GetTempPath()) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
        && Path.GetFileName(temp).StartsWith("smtracker-phase-b-tests-",StringComparison.Ordinal)) Directory.Delete(temp,true);
}
Console.WriteLine($"RESULT {passed} passed, {failed} failed");
Environment.ExitCode = failed == 0 ? 0 : 1;

sealed class MutatingParser(IEs3SaveParser inner, string path, string replacement,
    bool preserveTimestamp = false) : IEs3SaveParser
{
    private bool _changed;
    public SaveSnapshot Parse(string text, DateTimeOffset saveWriteTimeUtc, IGameDataProvider gameData)
    {
        var parsed = inner.Parse(text,saveWriteTimeUtc,gameData);
        if (!_changed)
        {
            _changed = true;
            var priorWriteTime = File.GetLastWriteTimeUtc(path);
            File.WriteAllText(path,replacement);
            File.SetLastWriteTimeUtc(path,preserveTimestamp ? priorWriteTime : DateTime.UtcNow.AddSeconds(3));
        }
        return parsed;
    }
}

sealed class MutableGameInstallDiscovery(GameInstall? current, Exception? failure = null) : IGameInstallDiscovery
{
    public GameInstall? Current { get; set; } = current;
    public Exception? Failure { get; set; } = failure;
    public GameInstall? Discover() => Failure is null ? Current : throw Failure;
}
