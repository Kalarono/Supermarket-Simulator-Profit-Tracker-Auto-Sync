using System.Net;
using System.Diagnostics;
using System.Text.Json;
using SupermarketTrackerSync;

var options = CliOptions.Parse(args);
if (options.Version)
{
    Console.WriteLine($"SupermarketTrackerSync {BuildInfo.HelperVersion}");
    Console.WriteLine($"Tracker {BuildInfo.TrackerVersion}; API schema {BuildInfo.ApiSchemaVersion}; mapping {BuildInfo.MappingDataVersion}");
    return;
}
var log = new RollingLog(BuildInfo.LogPath, options.Verbose, options.LiveTest);
AppDomain.CurrentDomain.UnhandledException += (_, eventArgs) =>
{
    if (eventArgs.ExceptionObject is Exception error) log.Error("Unhandled helper exception", error);
};
TaskScheduler.UnobservedTaskException += (_, eventArgs) =>
    log.Error("Unobserved helper task exception", eventArgs.Exception);
var discovery = new SaveDiscoveryService();
var localization = new GameLocalizationProvider();
if (options.InspectLocalization)
{
    Console.WriteLine(JsonSerializer.Serialize(localization.Inspect(), new JsonSerializerOptions(ApiJson.Options) { WriteIndented = true }));
    if (!localization.IsAvailable) Environment.ExitCode = 1;
    return;
}
var gameData = ProductMappingProvider.LoadBuiltIn();
var snapshots = new SnapshotService(discovery, new SaveReader(), new Es3SaveParser(), gameData, log, options.Save);
if (options.LiveTest) log.Live($"Live test diagnostics enabled; log={BuildInfo.LogPath}; game save read-only");

if (options.Once || options.Inspect)
{
    await snapshots.RefreshAsync();
    if (options.Inspect)
    {
        var snapshot = snapshots.Snapshot;
        var report = new {
            readOnly = true, status = snapshots.Status,
            fields = snapshot is null ? null : new {
                supplierUnitPrices = snapshot.Products.Count(p => p.SupplierUnitPrice.Status == "present"),
                supplierBoxPrices = snapshot.Products.Count(p => p.SupplierBoxPrice.Status == "present"),
                marketPrices = snapshot.Products.Count(p => p.MarketPrice.Status == "present"),
                playerSellPrices = snapshot.Products.Count(p => p.PlayerSellPrice.Status == "present"),
                averageCosts = snapshot.Products.Count(p => p.AverageCost.Status == "present"),
                discountRates = snapshot.Products.Count(p => p.DiscountRate.Status == "present"),
                mappedProducts = snapshot.Products.Count(p => p.GameData?.MappingStatus == "mapped"),
                unknownProductIds = snapshot.Products.Where(p => p.GameData is null).Select(p => p.ProductId).ToArray()
            },
            sample = snapshot?.Products.Take(3).ToArray()
        };
        Console.WriteLine(JsonSerializer.Serialize(report, new JsonSerializerOptions(ApiJson.Options) { WriteIndented = true }));
    }
    else Console.WriteLine(JsonSerializer.Serialize(snapshots.Status, ApiJson.Options));
    if (!snapshots.Status.Connected) Environment.ExitCode = 1;
    return;
}

using var instanceSemaphore = new Semaphore(initialCount: 1, maximumCount: 1,
    name: $"Local\\SupermarketTrackerSync-{options.Port}");
var isPrimary = instanceSemaphore.WaitOne(0);
if (!isPrimary)
{
    if (options.Open)
    {
        try { Process.Start(new ProcessStartInfo($"http://127.0.0.1:{options.Port}/") { UseShellExecute = true }); }
        catch (Exception ex) { Console.Error.WriteLine("Existing helper is running, but the browser could not be opened: " + ex.Message); }
    }
    return;
}

var builder = WebApplication.CreateBuilder(args: Array.Empty<string>());
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.WebHost.UseKestrel().UseUrls($"http://127.0.0.1:{options.Port}");
builder.Services.AddSingleton(discovery);
builder.Services.AddSingleton(log);
builder.Services.AddSingleton(snapshots);
builder.Services.AddSingleton(localization);
builder.Services.AddHostedService<SaveWatcherService>();
builder.Services.AddHostedService<GameLocalizationRefreshService>();
var app = builder.Build();
app.Use(async (context, next) =>
{
    // Reject DNS-rebinding names even though Kestrel binds only IPv4 loopback.
    if (!string.Equals(context.Request.Host.Host, "127.0.0.1", StringComparison.Ordinal)
        || context.Request.Host.Port != options.Port)
    { context.Response.StatusCode = 403; return; }
    if (context.Request.Method is not ("GET" or "OPTIONS")) { context.Response.StatusCode = 405; return; }
    if (context.Request.Headers.TryGetValue("Origin", out var origin))
    {
        var sameOrigin = origin == $"http://127.0.0.1:{options.Port}";
        if (!sameOrigin && (origin != "null" || !options.AllowFileOrigin))
        { context.Response.StatusCode = 403; return; }
        context.Response.Headers.Append("Access-Control-Allow-Origin", origin.ToString());
        context.Response.Headers.Append("Vary", "Origin");
        if (context.Request.Method == "OPTIONS")
        {
            context.Response.Headers.Append("Access-Control-Allow-Methods", "GET");
            if (context.Request.Headers.ContainsKey("Access-Control-Request-Private-Network"))
                context.Response.Headers.Append("Access-Control-Allow-Private-Network", "true");
        }
    }
    if (context.Request.Method == "OPTIONS") { context.Response.StatusCode = 204; return; }
    context.Response.Headers.Append("Cache-Control", "no-store");
    context.Response.Headers.Append("X-Content-Type-Options", "nosniff");
    context.Response.Headers.Append("X-Frame-Options", "DENY");
    await next();
});
foreach (var path in new[] { "/", "/tracker", "/src/game-sync.js", "/src/game-localization.js", "/src/ui-messages.js", "/src/ui-localization.js", "/src/profit-threshold.js", "/mapping-audit" })
    app.MapGet(path, (HttpContext context) => TrackerWebAssets.Get(context.Request.Path.Value!) is { } asset
        ? Results.Bytes(asset.Bytes, asset.ContentType) : Results.NotFound());
app.MapGet("/health", () => Results.Json(new { schemaVersion = BuildInfo.ApiSchemaVersion, status = "ok" }, ApiJson.Options));
app.MapGet("/status", (SnapshotService service) => Results.Json(service.Status, ApiJson.Options));
app.MapGet("/locales", (GameLocalizationProvider provider) =>
    Results.Json(provider.GetLocales(), ApiJson.Options));
app.MapGet("/localization/{locale}", (string locale, GameLocalizationProvider provider) =>
    Results.Json(provider.GetLocalization(locale), ApiJson.Options));
app.MapGet("/products", (SnapshotService service) => Results.Json(
    new { schemaVersion = BuildInfo.ApiSchemaVersion, snapshotHash = service.Snapshot?.SnapshotHash,
        sourceSave = service.Snapshot?.SourceSave, saveWriteTimeUtc = service.Snapshot?.SaveWriteTimeUtc,
        products = service.Snapshot?.Products ?? Array.Empty<ProductSnapshot>() }, ApiJson.Options));
app.MapGet("/licenses", (SnapshotService service) => Results.Json(new {
    schemaVersion = BuildInfo.ApiSchemaVersion, unlockedLicenses = service.Snapshot?.UnlockedLicenses ?? Array.Empty<int>(),
    activeLicenses = service.Snapshot?.ActiveLicenses ?? Array.Empty<int>() }, ApiJson.Options));
app.MapGet("/snapshot", (SnapshotService service) => service.Snapshot is { } snapshot
    ? Results.Json(snapshot, ApiJson.Options) : Results.NotFound(new { error = "No successfully parsed snapshot yet" }));
log.Info($"Starting read-only helper on 127.0.0.1:{options.Port}");
Console.WriteLine($"SupermarketTrackerSync (read-only) listening on http://127.0.0.1:{options.Port}");
app.Lifetime.ApplicationStopping.Register(() => log.Info("Helper stopped gracefully"));
if (options.Open)
    app.Lifetime.ApplicationStarted.Register(() => {
        try { Process.Start(new ProcessStartInfo($"http://127.0.0.1:{options.Port}/") { UseShellExecute = true }); }
        catch (Exception ex) { log.Warn("Could not open browser: " + ex.Message); }
    });
try { await app.RunAsync(); }
catch (Exception error) { log.Error("Helper host failed", error); throw; }
finally { instanceSemaphore.Release(); }

public static class ApiJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    { WriteIndented = false, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
}

public sealed record CliOptions(bool Once, bool Inspect, string? Save, int Port, bool Verbose, bool AllowFileOrigin,
    bool InspectLocalization = false,
    bool Open = true, bool LiveTest = false, bool Version = false)
{
    public static CliOptions Parse(string[] args)
    {
        bool once = false, inspect = false, inspectLocalization = false, verbose = false, allowFileOrigin = false, open = true,
            liveTest = false, version = false;
        string? save = null; int port = 47831;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--once": once = true; break;
                case "--inspect": inspect = true; break;
                case "--inspect-localization": inspectLocalization = true; break;
                case "--open": open = true; break;
                case "--no-open": open = false; break;
                case "--verbose": verbose = true; break;
                case "--live-test": liveTest = true; break;
                case "--version": version = true; break;
                case "--allow-file-origin": allowFileOrigin = true; break;
                case "--deny-file-origin": allowFileOrigin = false; break;
                case "--save":
                    if (++i >= args.Length) throw new ArgumentException("--save requires path");
                    save = Path.GetFullPath(args[i]);
                    if (!save.EndsWith(".es3", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("--save requires .es3 file");
                    break;
                case "--port":
                    if (++i >= args.Length || !int.TryParse(args[i], out port) || port is < 1024 or > 65535)
                        throw new ArgumentException("--port must be between 1024 and 65535");
                    break;
                default: throw new ArgumentException("Unknown option: " + args[i]);
            }
        }
        return new(once, inspect, save, port, verbose, allowFileOrigin, inspectLocalization, open, liveTest, version);
    }
}
