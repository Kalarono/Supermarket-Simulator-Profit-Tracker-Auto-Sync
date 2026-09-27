namespace SupermarketTrackerSync;

// Only these exact URLs can expose resources compiled from this repository.
// No request path is ever passed to File.Open/Path.Combine or a generic file server.
public static class TrackerWebAssets
{
    public static (byte[] Bytes, string ContentType)? Get(string path)
    {
        var resource = path switch {
            "/" or "/tracker" => ("Tracker.html", "text/html; charset=utf-8"),
            "/src/game-sync.js" => ("Tracker.game-sync.js", "text/javascript; charset=utf-8"),
            "/src/game-localization.js" => ("Tracker.game-localization.js", "text/javascript; charset=utf-8"),
            "/src/ui-messages.js" => ("Tracker.ui-messages.js", "text/javascript; charset=utf-8"),
            "/src/ui-localization.js" => ("Tracker.ui-localization.js", "text/javascript; charset=utf-8"),
            "/src/profit-threshold.js" => ("Tracker.profit-threshold.js", "text/javascript; charset=utf-8"),
            "/mapping-audit" => ("Tracker.mapping-audit.json", "application/json; charset=utf-8"),
            _ => (null, null)
        };
        if (resource.Item1 is null) return null;
        using var stream = typeof(TrackerWebAssets).Assembly.GetManifestResourceStream(resource.Item1);
        if (stream is null) return null;
        using var buffer = new MemoryStream(); stream.CopyTo(buffer);
        return (buffer.ToArray(), resource.Item2!);
    }
}
