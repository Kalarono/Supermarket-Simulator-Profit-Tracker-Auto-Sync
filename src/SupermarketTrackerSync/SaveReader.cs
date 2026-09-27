using System.Text;

namespace SupermarketTrackerSync;

public sealed class SaveReader
{
    public async Task<(string Text, DateTimeOffset LastWrite, long Length)> ReadStableAsync(
        string path, CancellationToken token, Action<string>? diagnostic = null)
    {
        Exception? last = null;
        for (int attempt = 0; attempt < 8; attempt++)
        {
            token.ThrowIfCancellationRequested();
            try
            {
                var before = new FileInfo(path);
                if (!before.Exists) throw new FileNotFoundException("Save disappeared", path);
                long length = before.Length;
                DateTime write = before.LastWriteTimeUtc;
                await Task.Delay(250, token);
                var stable = new FileInfo(path);
                if (stable.Length != length || stable.LastWriteTimeUtc != write) throw new IOException("Save is still being written");
                await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete, 65536, FileOptions.Asynchronous | FileOptions.SequentialScan);
                using var reader = new StreamReader(stream, new UTF8Encoding(false, true), detectEncodingFromByteOrderMarks: true);
                string text = await reader.ReadToEndAsync(token);
                var after = new FileInfo(path);
                if (after.Length != length || after.LastWriteTimeUtc != write || stream.Length != length)
                    throw new IOException("Save changed during read");
                diagnostic?.Invoke($"Save stable after {attempt + 1} read attempt(s); {length} bytes");
                return (text, new DateTimeOffset(write, TimeSpan.Zero), length);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or DecoderFallbackException)
            {
                last = ex;
                diagnostic?.Invoke($"Read attempt {attempt + 1}/8 delayed: {ex.GetType().Name}: {ex.Message}");
                if (attempt < 7) await Task.Delay(200 * (attempt + 1), token);
            }
        }
        throw new IOException("Could not read stable save after retries", last);
    }
}
