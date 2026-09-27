namespace SupermarketTrackerSync;

public sealed class SaveWatcherService : BackgroundService
{
    private readonly SnapshotService _snapshots;
    private readonly RollingLog _log;
    private int _watcherEvents;
    public SaveWatcherService(SnapshotService snapshots, RollingLog log)
    { _snapshots = snapshots; _log = log; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        FileSystemWatcher? watcher = null;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                var directory = _snapshots.WatchDirectory;
                if (watcher is null && Directory.Exists(directory))
                {
                    watcher = new FileSystemWatcher(directory, "*.es3")
                    { NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size };
                    watcher.Changed += (_, e) => NoteEvent("Changed", e.Name);
                    watcher.Created += (_, e) => NoteEvent("Created", e.Name);
                    watcher.Renamed += (_, e) => NoteEvent("Renamed", $"{e.OldName} -> {e.Name}");
                    watcher.Error += (_, e) => _log.Warn("Watcher error; periodic polling remains active: " +
                        (e.GetException()?.Message ?? "unknown watcher error"));
                    watcher.EnableRaisingEvents = true;
                    _log.Info("Save directory found; watcher active");
                    _log.Live($"FileSystemWatcher active in {directory}");
                }
                else if (watcher is not null && !Directory.Exists(directory))
                { watcher.Dispose(); watcher = null; }
                var events = Interlocked.Exchange(ref _watcherEvents, 0);
                if (events > 0) _log.Live($"Coalescing {events} FileSystemWatcher event(s) into this polling refresh");
                var before = _snapshots.Snapshot;
                await _snapshots.RefreshAsync(stoppingToken);
                if (!ReferenceEquals(before, _snapshots.Snapshot))
                    _log.Live($"One usable snapshot published for {_snapshots.Status.SelectedSave}");
                await Task.Delay(2000, stoppingToken); // polling repairs missed/coalesced watcher events
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally { watcher?.Dispose(); }
    }

    private void NoteEvent(string kind, string? name)
    {
        _log.Info($"Save {kind.ToLowerInvariant()}: {name}");
        if (!_log.LiveTest) return;
        Interlocked.Increment(ref _watcherEvents);
        _log.Live($"FileSystemWatcher {kind} detected: {name}");
    }
}
