using System.Text.RegularExpressions;

namespace SupermarketTrackerSync;

public sealed class SaveDiscoveryService
{
    private static readonly Regex SlotPattern = new("^slot_[0-9]+\\.es3$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private readonly string? _directoryOverride;
    public SaveDiscoveryService(string? directoryOverride = null) => _directoryOverride = directoryOverride;
    public string DefaultDirectory => _directoryOverride ?? Path.Combine(Environment.GetEnvironmentVariable("USERPROFILE")
        ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        "AppData", "LocalLow", "Nokta Games", "Supermarket Simulator");

    public SaveSelection Discover(string? overridePath = null)
    {
        var directory = overridePath is null ? DefaultDirectory : Path.GetDirectoryName(Path.GetFullPath(overridePath))!;
        if (!Directory.Exists(directory)) return new(directory, null, Array.Empty<SaveCandidate>(), "directory-not-found");
        var slots = Directory.EnumerateFiles(directory, "*.es3", SearchOption.TopDirectoryOnly)
            .Select(path => new FileInfo(path))
            .Select(f => new SaveCandidate(f.Name, f.FullName, f.Length, f.LastWriteTimeUtc,
                SlotPattern.IsMatch(f.Name), f.Name.Contains("_bk_", StringComparison.OrdinalIgnoreCase)))
            .OrderByDescending(f => f.LastWriteTimeUtc).ThenBy(f => f.Name, StringComparer.Ordinal)
            .ToArray();
        if (overridePath is not null)
        {
            var chosen = slots.SingleOrDefault(s => string.Equals(s.FullPath, Path.GetFullPath(overridePath), StringComparison.OrdinalIgnoreCase));
            if (chosen is null) throw new FileNotFoundException("Explicit .es3 save not found", overridePath);
            return new(directory, chosen, slots, "explicit --save override");
        }
        var active = slots.Where(s => s.IsActiveSlot && !s.IsBackup).ToArray();
        if (active.Length > 0) return new(directory, active[0], slots,
            active.Length > 1 ? "newest active slot proposed; other slots available via --save" : "only active slot");
        return new(directory, null, slots, "no active slot_N.es3; backups/archives are not selected automatically");
    }
}
