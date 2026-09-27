using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace SupermarketTrackerSync;

public sealed record GameInstall(string InstallRoot, string GameDataDirectory, string SteamBuildId);

public interface IGameInstallDiscovery
{
    GameInstall? Discover();
}

/// <summary>Finds Supermarket Simulator through Steam registry and library metadata.</summary>
public sealed class SteamGameInstallDiscovery : IGameInstallDiscovery
{
    private static readonly Regex QuotedValue = new("\\\"(?<key>[^\\\"]+)\\\"\\s*\\\"(?<value>(?:\\\\.|[^\\\"])*)\\\"",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public GameInstall? Discover()
    {
        foreach (var library in GetSteamLibraries())
        {
            var steamApps = Path.Combine(library, "steamapps");
            if (!Directory.Exists(steamApps)) continue;
            IEnumerable<string> manifests;
            try { manifests = Directory.EnumerateFiles(steamApps, "appmanifest_*.acf", SearchOption.TopDirectoryOnly).ToArray(); }
            catch (IOException) { continue; }
            foreach (var manifest in manifests)
            {
                string contents;
                try { contents = File.ReadAllText(manifest, Encoding.UTF8); }
                catch (IOException) { continue; }
                var values = ReadValues(contents);
                if (!values.TryGetValue("name", out var name) ||
                    !string.Equals(name, "Supermarket Simulator", StringComparison.OrdinalIgnoreCase) ||
                    !values.TryGetValue("installdir", out var installDirectory) ||
                    !values.TryGetValue("buildid", out var buildId)) continue;

                var installRoot = Path.Combine(steamApps, "common", installDirectory);
                var dataDirectory = FindGameDataDirectory(installRoot);
                if (dataDirectory is not null) return new(installRoot, dataDirectory, buildId);
            }
        }
        return null;
    }

    private static IEnumerable<string> GetSteamLibraries()
    {
        var roots = new List<string>();
        if (OperatingSystem.IsWindows())
        {
            ReadSteamRegistry(Registry.CurrentUser, @"Software\Valve\Steam", roots);
            ReadSteamRegistry(Registry.LocalMachine, @"Software\WOW6432Node\Valve\Steam", roots);
            ReadSteamRegistry(Registry.LocalMachine, @"Software\Valve\Steam", roots);
        }

        var libraries = new List<string>();
        foreach (var root in roots.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            libraries.Add(root);
            var vdf = Path.Combine(root, "steamapps", "libraryfolders.vdf");
            if (!File.Exists(vdf)) continue;
            string text;
            try { text = File.ReadAllText(vdf, Encoding.UTF8); }
            catch (IOException) { continue; }
            foreach (var match in QuotedValue.Matches(text).Cast<Match>())
            {
                if (!string.Equals(match.Groups["key"].Value, "path", StringComparison.Ordinal)) continue;
                var path = UnescapeVdf(match.Groups["value"].Value);
                if (!libraries.Contains(path, StringComparer.OrdinalIgnoreCase)) libraries.Add(path);
            }
        }
        return libraries;
    }

    [SupportedOSPlatform("windows")]
    private static void ReadSteamRegistry(RegistryKey hive, string subKey, ICollection<string> roots)
    {
        try
        {
            using var key = hive.OpenSubKey(subKey);
            var path = key?.GetValue("SteamPath") as string;
            if (!string.IsNullOrWhiteSpace(path)) roots.Add(path.Replace('/', Path.DirectorySeparatorChar));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Security.SecurityException) { }
    }

    private static Dictionary<string, string> ReadValues(string text) => QuotedValue.Matches(text)
        .Cast<Match>().GroupBy(match => match.Groups["key"].Value, StringComparer.OrdinalIgnoreCase)
        .ToDictionary(group => group.Key, group => UnescapeVdf(group.Last().Groups["value"].Value), StringComparer.OrdinalIgnoreCase);

    private static string UnescapeVdf(string value) => value.Replace("\\\\", "\\", StringComparison.Ordinal);

    private static string? FindGameDataDirectory(string installRoot)
    {
        var direct = Path.Combine(installRoot, "Supermarket Simulator_Data");
        if (Directory.Exists(Path.Combine(direct, "StreamingAssets", "aa"))) return direct;
        if (!Directory.Exists(installRoot)) return null;
        try
        {
            return Directory.EnumerateDirectories(installRoot, "*_Data", SearchOption.TopDirectoryOnly)
                .FirstOrDefault(path => Directory.Exists(Path.Combine(path, "StreamingAssets", "aa")));
        }
        catch (IOException) { return null; }
    }
}

public sealed record LocalizationLocalesResponse(
    int SchemaVersion, IReadOnlyList<string> Available, IReadOnlyList<string> Detected,
    string? GameVersion, string? SteamBuildId, string? BundleFingerprint, string? Warning);

public sealed record LocalizedProductResponse(
    int ProductId, string? CanonicalCategory, string? CanonicalBrand,
    string? LocalizedCategory, string? LocalizedBrand, string? LocalizedLabel,
    string? DisplayName, string Source, string? Key);

public sealed record LocalizationResponse(
    int SchemaVersion, string RequestedLocale, string Locale, string Source,
    string? GameVersion, string? SteamBuildId, string? BundleFingerprint, bool Available,
    string? FallbackLocale, string? Warning,
    IReadOnlyDictionary<string, LocalizedProductResponse> Products);

public sealed record LocalizationInspection(
    bool ReadOnly, bool Available, string? InstallRoot, string? GameVersion, string? SteamBuildId,
    string? BundleFingerprint, IReadOnlyList<string> DetectedLanguages,
    int EnglishStringTables, int RussianStringTables, int SharedKeys,
    int ProductRelatedKeys, int ConfirmedProducts, int LocalizedProductLabels,
    int CategoryLocalized, int BrandLocalized, int FallbackEnglish,
    string? Warning, IReadOnlyList<object> Samples);

/// <summary>
/// Serves a generated, versioned game-localization catalog. Addressables parsing happens in the
/// developer extraction tool; the packaged helper only validates fingerprints and reads JSON.
/// </summary>
public sealed class GameLocalizationProvider
{
    private readonly object _gate = new();
    private readonly IGameInstallDiscovery _discovery;
    private readonly LocalizationCatalog? _catalog;
    private GameInstall? _install;
    private bool _available;
    private string? _warning;
    private string? _quickStamp;

    public GameLocalizationProvider() : this(OpenBuiltInCatalog(), new SteamGameInstallDiscovery()) { }

    public GameLocalizationProvider(Stream? catalogStream, IGameInstallDiscovery discovery)
    {
        _discovery = discovery;
        if (catalogStream is not null)
        {
            try
            {
                _catalog = JsonSerializer.Deserialize<LocalizationCatalog>(catalogStream,
                    new JsonSerializerOptions(JsonSerializerDefaults.Web));
                var catalogError = _catalog is null ? "Localization catalog is empty or unsupported." : GetCatalogError(_catalog);
                if (catalogError is not null)
                {
                    _warning = catalogError;
                    _catalog = null;
                }
            }
            catch (Exception error) when (error is JsonException or IOException)
            { _warning = "Localization catalog could not be read: " + error.Message; }
        }
        else _warning = "Built-in game-localization catalog is missing.";
        Refresh(force: true);
    }

    public string? Warning { get { lock (_gate) return _warning; } }
    public bool IsAvailable { get { lock (_gate) return _available; } }

    /// <summary>Checks the small localization bundle hashes on each bounded refresh poll.</summary>
    public bool Refresh(bool force = false)
    {
        lock (_gate)
        {
            GameInstall? install;
            try { install = _discovery.Discover(); }
            catch (Exception error)
            {
                _install = null;
                const string failedDiscoveryStamp = "steam-discovery-failed";
                if (!force && _quickStamp == failedDiscoveryStamp) return false;
                _quickStamp = failedDiscoveryStamp;
                return MarkUnavailable("Steam game discovery failed; using English tracker labels: " + error.Message);
            }
            _install = install;
            if (install is null)
            {
                _available = false;
                if (!force && _quickStamp == "steam-game-not-found") return false;
                _quickStamp = "steam-game-not-found";
                _warning = "Supermarket Simulator was not found through Steam metadata; using English tracker labels.";
                return true;
            }
            if (_catalog is null)
            {
                _available = false;
                _warning ??= "Localization catalog is unavailable; using English tracker labels.";
                return true;
            }

            string stamp;
            try { stamp = CreateQuickStamp(install, _catalog.Cache); }
            catch (Exception error)
            {
                _quickStamp = null;
                return MarkUnavailable("Game localization fingerprint check failed; using English tracker labels: " + error.Message);
            }
            if (!force && stamp == _quickStamp) return false;
            _quickStamp = stamp;

            try
            {
                if (!string.Equals(install.SteamBuildId, _catalog.Game.SteamBuildId, StringComparison.Ordinal))
                    return MarkUnavailable($"Game build changed (installed {install.SteamBuildId}, catalog {_catalog.Game.SteamBuildId}); regenerate the localization catalog.");

                foreach (var bundle in _catalog.Cache.BundleFiles)
                {
                    var path = FindNamedFile(Path.Combine(install.GameDataDirectory, "StreamingAssets", "aa"), bundle.Name);
                    if (path is null || new FileInfo(path).Length != bundle.Length)
                        return MarkUnavailable($"Localization bundle '{bundle.Name}' is missing or changed; using English tracker labels.");
                    if (!string.Equals(HashFile(path), bundle.Sha256, StringComparison.OrdinalIgnoreCase))
                        return MarkUnavailable($"Localization bundle '{bundle.Name}' has a new fingerprint; regenerate the localization catalog.");
                }
                foreach (var asset in _catalog.Cache.ProductAssetFiles)
                {
                    var path = Path.Combine(install.GameDataDirectory, asset.Name);
                    if (!File.Exists(path)) return MarkUnavailable($"Product asset '{asset.Name}' is missing; localization mapping was invalidated.");
                    var info = new FileInfo(path);
                    var expected = DateTimeOffset.Parse(asset.LastWriteTimeUtc, CultureInfo.InvariantCulture).UtcDateTime;
                    if (info.Length != asset.Length || Math.Abs((info.LastWriteTimeUtc - expected).TotalSeconds) > 1)
                        return MarkUnavailable($"Product asset '{asset.Name}' changed; regenerate the localization catalog.");
                }
            }
            catch (Exception error)
            { return MarkUnavailable("Game localization validation failed; using English tracker labels: " + error.Message); }

            _available = true;
            _warning = null;
            return true;
        }
    }

    public LocalizationLocalesResponse GetLocales()
    {
        lock (_gate)
        {
            var valid = _available && _catalog is not null;
            return new(1,
                valid ? _catalog!.AvailableLocales : new[] { "en" },
                valid ? _catalog!.DetectedLocales : Array.Empty<string>(),
                valid ? _catalog!.Game.GameVersion : null,
                _install?.SteamBuildId,
                valid ? _catalog!.Cache.Fingerprint : null,
                _warning);
        }
    }

    public LocalizationResponse GetLocalization(string requestedLocale)
    {
        lock (_gate)
        {
            var requestedSupported = requestedLocale is "en" or "ru-RU";
            var locale = requestedSupported ? requestedLocale : "en";
            var supported = requestedSupported && _available && _catalog is not null
                && _catalog.AvailableLocales.Contains(locale, StringComparer.Ordinal);
            var warning = _warning;
            string? fallback = null;
            if (!supported)
            {
                fallback = "en";
                warning ??= requestedLocale is "en" or "ru-RU"
                    ? "Official localization is unavailable; display canonical English tracker labels."
                    : $"Locale '{requestedLocale}' is unsupported; display canonical English tracker labels.";
            }
            var values = new Dictionary<string, LocalizedProductResponse>(StringComparer.Ordinal);
            if (supported)
            {
                foreach (var product in _catalog!.Products)
                {
                    var label = locale == "ru-RU" ? product.Localization.Russian : product.Localization.English;
                    if (string.IsNullOrWhiteSpace(label)) continue;
                    var display = locale == "ru-RU" ? product.Localization.RussianDisplayName : product.Localization.EnglishDisplayName;
                    var localizedCategory = string.Equals(product.Localization.Table, "Products", StringComparison.Ordinal)
                        ? label : null;
                    var key = string.IsNullOrWhiteSpace(product.Localization.Table) || string.IsNullOrWhiteSpace(product.Localization.Key)
                        ? null : $"{product.Localization.Table}:{product.Localization.Key}";
                    values[product.ProductId.ToString(CultureInfo.InvariantCulture)] = new(
                        product.ProductId, product.Canonical.Category, product.Canonical.Brand,
                        localizedCategory, null, label, display ?? label, "game-localization", key);
                }
            }
            return new(1, requestedLocale, supported ? locale : "en", supported ? "game-localization" : "canonical-fallback",
                supported ? _catalog!.Game.GameVersion : null, _install?.SteamBuildId,
                supported ? _catalog!.Cache.Fingerprint : null,
                supported, fallback, warning, values);
        }
    }

    public LocalizationInspection Inspect()
    {
        lock (_gate)
        {
            var coverage = _catalog?.Coverage;
            var samples = _catalog?.Products.Where(product => new[] { 33, 70, 73, 1, 28, 189, 210, 273, 274, 303, 311 }.Contains(product.ProductId))
                .Select(product => (object)new
                {
                    product.ProductId,
                    product.AssetName,
                    canonical = product.Canonical.DisplayName,
                    table = product.Localization.Table,
                    key = product.Localization.Key,
                    english = product.Localization.English,
                    russian = product.Localization.Russian,
                    source = product.Localization.Source,
                    mappingStatus = product.MappingStatus
                }).ToArray() ?? Array.Empty<object>();
            return new(true, _available, _install?.InstallRoot, _available ? _catalog?.Game.GameVersion : null, _install?.SteamBuildId,
                _available ? _catalog?.Cache.Fingerprint : null,
                _available ? _catalog?.DetectedLocales ?? Array.Empty<string>() : Array.Empty<string>(),
                _available ? _catalog?.Tables.LocaleTableCounts.GetValueOrDefault("en") ?? 0 : 0,
                _available ? _catalog?.Tables.LocaleTableCounts.GetValueOrDefault("ru-RU") ?? 0 : 0,
                _available ? _catalog?.Tables.SharedKeyCount ?? 0 : 0,
                _available ? _catalog?.Tables.ProductRelatedKeys ?? 0 : 0,
                coverage?.ConfirmedProducts ?? 0,
                coverage?.LocalizedProductLabels ?? 0,
                coverage?.CategoryLocalized ?? 0,
                coverage?.BrandLocalized ?? 0,
                coverage?.FallbackEnglish ?? 0,
                _warning, samples);
        }
    }

    private bool MarkUnavailable(string warning)
    {
        _available = false;
        _warning = warning;
        return true;
    }

    private static string CreateQuickStamp(GameInstall install, LocalizationCache cache)
    {
        var pieces = new List<string> { install.SteamBuildId };
        foreach (var file in cache.BundleFiles)
        {
            var path = FindNamedFile(Path.Combine(install.GameDataDirectory, "StreamingAssets", "aa"), file.Name);
            pieces.Add(path is null ? file.Name + ":missing" : FileStamp(path) + ":" + HashFile(path));
        }
        foreach (var file in cache.ProductAssetFiles)
        {
            var path = Path.Combine(install.GameDataDirectory, file.Name);
            pieces.Add(File.Exists(path) ? FileStamp(path) : file.Name + ":missing");
        }
        return string.Join("|", pieces);
    }

    private static string FileStamp(string path)
    {
        var info = new FileInfo(path);
        return $"{info.Name}:{info.Length}:{info.LastWriteTimeUtc.Ticks}";
    }

    private static string? FindNamedFile(string directory, string name)
    {
        if (!Directory.Exists(directory)) return null;
        try { return Directory.EnumerateFiles(directory, name, SearchOption.AllDirectories).FirstOrDefault(); }
        catch (IOException) { return null; }
    }

    private static string HashFile(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static Stream? OpenBuiltInCatalog()
        => typeof(GameLocalizationProvider).Assembly.GetManifestResourceStream("Tracker.game-localization.json");

    private sealed record LocalizationCatalog(int SchemaVersion, string Source, LocalizationGame Game,
        LocalizationCache Cache, string[] DetectedLocales, string[] AvailableLocales,
        LocalizationTables Tables, LocalizationCoverage Coverage, LocalizationProduct[] Products);
    private sealed record LocalizationGame(string? SteamBuildId, string? GameVersion);
    private sealed record LocalizationCache(string Fingerprint, LocalizationBundle[] BundleFiles,
        LocalizationAsset[] ProductAssetFiles);
    private sealed record LocalizationBundle(string Name, long Length, string LastWriteTimeUtc, string Sha256);
    private sealed record LocalizationAsset(string Name, long Length, string LastWriteTimeUtc);
    private sealed record LocalizationTables(int SharedTableCount, int SharedKeyCount,
        Dictionary<string, int> LocaleTableCounts, int ProductRelatedKeys);
    private sealed record LocalizationCoverage(int ConfirmedProducts, int LocalizedProductLabels,
        int CategoryLocalized, int BrandLocalized, int FallbackEnglish, int GameOnlyBakeryBaked, int Ambiguous);
    private sealed record LocalizationProduct(int ProductId, string AssetName, CanonicalProduct Canonical,
        LocalizationStrings Localization, string MappingStatus);
    private sealed record CanonicalProduct(string Category, string? Brand, string DisplayName);
    private sealed record LocalizationStrings(string? Table, string? Key, long Id, string? English,
        string? Russian, string Source, string? EnglishDisplayName, string? RussianDisplayName);

    private static string? GetCatalogError(LocalizationCatalog catalog)
    {
        if (catalog.SchemaVersion != 1) return "Localization catalog schema is missing or unsupported.";
        if (catalog.Game is null || string.IsNullOrWhiteSpace(catalog.Game.SteamBuildId)
            || catalog.Cache is null || catalog.Tables is null || catalog.Tables.LocaleTableCounts is null
            || catalog.Coverage is null || catalog.Products is null || catalog.AvailableLocales is null
            || catalog.DetectedLocales is null)
            return "Localization catalog is incomplete; using English tracker labels.";
        if (!catalog.AvailableLocales.Contains("en", StringComparer.Ordinal)
            || !catalog.AvailableLocales.Contains("ru-RU", StringComparer.Ordinal)
            || catalog.AvailableLocales.Any(locale => locale is not ("en" or "ru-RU")))
            return "Localization catalog has unsupported display locales; using English tracker labels.";
        if (catalog.Cache.BundleFiles is null || catalog.Cache.BundleFiles.Length == 0
            || catalog.Cache.ProductAssetFiles is null)
            return "Localization catalog cache metadata is incomplete; using English tracker labels.";
        if (catalog.Cache.BundleFiles.Any(file => file is null || !IsSafeAssetName(file.Name)
                || !Regex.IsMatch(file.Sha256 ?? "", "^[0-9a-fA-F]{64}$", RegexOptions.CultureInvariant)))
            return "Localization catalog contains invalid bundle metadata; using English tracker labels.";
        if (catalog.Cache.ProductAssetFiles.Any(file => file is null || !IsSafeAssetName(file.Name)))
            return "Localization catalog contains invalid product asset metadata; using English tracker labels.";
        var ids = new HashSet<int>();
        foreach (var product in catalog.Products)
        {
            if (product is null || product.ProductId <= 0 || !ids.Add(product.ProductId)
                || product.Canonical is null || product.Localization is null
                || string.IsNullOrWhiteSpace(product.Canonical.DisplayName)
                || string.IsNullOrWhiteSpace(product.Localization.English)
                || string.IsNullOrWhiteSpace(product.Localization.Russian))
                return "Localization catalog contains invalid ProductID records; using English tracker labels.";
        }
        return null;
    }

    private static bool IsSafeAssetName(string? name)
        => !string.IsNullOrWhiteSpace(name) && string.Equals(Path.GetFileName(name), name, StringComparison.Ordinal)
            && name.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && !name.Contains('*') && !name.Contains('?');
}

public sealed class GameLocalizationRefreshService(GameLocalizationProvider localization, RollingLog log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                if (localization.Refresh())
                    log.Info(localization.IsAvailable ? "Game localization fingerprint is current" :
                        "Game localization unavailable: " + localization.Warning);
            }
            catch (Exception error) { log.Warn("Game localization refresh failed: " + error.Message); }
        }
    }
}
