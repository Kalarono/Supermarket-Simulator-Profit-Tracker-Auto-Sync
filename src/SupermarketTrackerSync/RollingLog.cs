namespace SupermarketTrackerSync;

public sealed class RollingLog
{
    private readonly string _path;
    private readonly object _gate = new();
    private readonly bool _verbose;
    private readonly bool _liveTest;
    public RollingLog(string path, bool verbose = false, bool liveTest = false)
    { _path = path; _verbose = verbose || liveTest; _liveTest = liveTest; }
    public bool LiveTest => _liveTest;
    public void Info(string message) => Write("INFO", message);
    public void Warn(string message) => Write("WARN", message);
    public void Live(string message) { if (_liveTest) Write("LIVE", message); }
    public void Error(string message, Exception error) => Write("ERROR", message + ": " + error);
    private void Write(string level, string message)
    {
        var line = $"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss}] [{level}] {message}";
        if (_verbose || level is "WARN" or "ERROR") Console.Error.WriteLine(line);
        lock (_gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                if (File.Exists(_path) && new FileInfo(_path).Length > 1_000_000)
                {
                    for (int i = 2; i >= 1; i--)
                    {
                        var previous = i == 1 ? _path : _path + "." + (i - 1);
                        if (File.Exists(previous)) File.Move(previous, _path + "." + i, overwrite: true);
                    }
                }
                File.AppendAllText(_path, line + Environment.NewLine);
            }
            catch (IOException) { /* Logging must not stop read-only sync. */ }
            catch (UnauthorizedAccessException) { }
        }
    }
}
