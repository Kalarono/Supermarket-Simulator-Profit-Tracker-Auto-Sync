using System.Security.Cryptography;

namespace SupermarketTrackerSync;

public static class BuildInfo
{
    public const string HelperVersion = "1.0.0";
    public const string TrackerVersion = "2.9";
    public const int ApiSchemaVersion = 3;

    private static readonly Lazy<string> MappingVersion = new(() =>
    {
        using var stream = typeof(BuildInfo).Assembly.GetManifestResourceStream("Tracker.product-map.json")
            ?? throw new InvalidDataException("Built-in ProductID mapping resource is missing");
        return "sha256:" + Convert.ToHexString(SHA256.HashData(stream))[..12].ToLowerInvariant();
    });

    public static string MappingDataVersion => MappingVersion.Value;

    public static string LogPath
    {
        get
        {
            var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrWhiteSpace(localData)) localData = Path.GetTempPath();
            return Path.Combine(localData, "SupermarketTrackerSync", "logs", "helper.log");
        }
    }
}
