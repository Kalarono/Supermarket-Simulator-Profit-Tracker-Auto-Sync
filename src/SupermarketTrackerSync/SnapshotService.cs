namespace SupermarketTrackerSync;

public sealed class SnapshotService
{
    private readonly SaveDiscoveryService _discovery;
    private readonly SaveReader _reader;
    private readonly IEs3SaveParser _parser;
    private readonly IGameDataProvider _gameData;
    private readonly RollingLog _log;
    private readonly string? _overridePath;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private SaveSnapshot? _snapshot;
    private HelperStatus _status = new(BuildInfo.ApiSchemaVersion, BuildInfo.HelperVersion, false, false, null, "not checked", Array.Empty<SaveCandidate>(),
        null, null, null, null, 0, Array.Empty<string>(), null);

    public SnapshotService(SaveDiscoveryService discovery, SaveReader reader, IEs3SaveParser parser,
        IGameDataProvider gameData, RollingLog log, string? overridePath = null)
    { _discovery = discovery; _reader = reader; _parser = parser; _gameData = gameData; _log = log; _overridePath = overridePath; }

    public SaveSnapshot? Snapshot => Volatile.Read(ref _snapshot);
    public HelperStatus Status => Volatile.Read(ref _status);
    public string WatchDirectory => _overridePath is null ? _discovery.DefaultDirectory : Path.GetDirectoryName(_overridePath)!;

    public async Task RefreshAsync(CancellationToken token = default)
    {
        await _gate.WaitAsync(token);
        try
        {
            SaveSelection selection;
            try { selection = _discovery.Discover(_overridePath); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            { PublishError("Save discovery failed: " + ex.Message); return; }
            var old = Status;
            if (old.SaveSlots.Count != selection.Slots.Count)
                _log.Info($"Save files detected: {selection.Slots.Count}; active slots: {selection.Slots.Count(s => s.IsActiveSlot)}");
            if (selection.Selected is null)
            {
                Volatile.Write(ref _status, old with { Connected = false,
                    SaveDirectoryFound = Directory.Exists(selection.Directory), SelectedSave = null,
                    SelectionReason = selection.Reason, SaveSlots = selection.Slots,
                    LastAttempt = DateTimeOffset.UtcNow, Error = "No active save selected" });
                return;
            }
            var candidate = selection.Selected;
            var previousCandidate = old.SaveSlots.FirstOrDefault(slot => slot.Name == candidate.Name);
            bool same = old.Connected && old.SelectedSave == candidate.Name
                && old.LastSaveWriteTime == candidate.LastWriteTimeUtc
                && previousCandidate?.Length == candidate.Length && Snapshot is not null;
            if (same)
            {
                Volatile.Write(ref _status, old with { SaveSlots = selection.Slots, SelectionReason = selection.Reason });
                return;
            }
            Volatile.Write(ref _status, old with { LastAttempt = DateTimeOffset.UtcNow,
                SaveDirectoryFound = true, SelectedSave = candidate.Name, SaveSlots = selection.Slots,
                SelectionReason = selection.Reason });
            try
            {
                _log.Info($"Reading {candidate.Name}; waiting for file stabilization");
                _log.Live($"Watching {candidate.Name}; stable-read check started");
                var (text, writeTime, length) = await _reader.ReadStableAsync(candidate.FullPath, token, _log.Live);
                var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
                    System.Text.Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
                var parsed = _parser.Parse(text, writeTime, _gameData) with { SourceSave = candidate.Name, SnapshotHash = hash };
                var latest = _discovery.Discover(_overridePath).Selected;
                if (latest is null || !string.Equals(latest.FullPath, candidate.FullPath, StringComparison.OrdinalIgnoreCase)
                    || latest.LastWriteTimeUtc != writeTime || latest.Length != length)
                    throw new IOException("A newer save or different active slot appeared before snapshot publication");
                // A fresh, completely constructed immutable snapshot is published in one operation.
                Volatile.Write(ref _snapshot, parsed);
                Volatile.Write(ref _status, Status with { Connected = true, GameVersion = parsed.GameVersion,
                    LastSaveWriteTime = parsed.SaveWriteTimeUtc, LastSuccessfulParse = parsed.ParsedAtUtc,
                    ProductCount = parsed.Products.Count, Warnings = parsed.Warnings, Error = null, SnapshotHash = hash });
                _log.Info($"Parsed {parsed.Products.Count} products from {candidate.Name}");
                _log.Live($"Parse successful; snapshotId={candidate.Name}|{writeTime:O}|{hash}; " +
                    $"products={parsed.Products.Count}; playerSellPresent={parsed.Products.Count(p => p.PlayerSellPrice.Status == "present")}");
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
            {
                PublishError("Save read/parse failed: " + ex.Message);
            }
        }
        finally { _gate.Release(); }
    }

    private void PublishError(string error)
    {
        Volatile.Write(ref _status, Status with { Connected = false, Error = error, LastAttempt = DateTimeOffset.UtcNow });
        _log.Warn(error);
    }
}
