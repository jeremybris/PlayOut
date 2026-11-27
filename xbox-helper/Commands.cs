using System.Text.Json;
using CHDSharp;
using CHDSharp.Encoder;
using CHDSharp.Encoder.Models;
using CHDSharp.Models;
using XISOSharp;
using XISOSharp.Models;
using ZArchiveSharp.Pipeline;

namespace PlayOutXbox;

/// <summary>A failure to report as-is (bad input, failed verification): no stack trace, exit code 1.</summary>
internal sealed class UserError(string message) : Exception(message);

/// <summary>Synchronous IProgress (Progress&lt;T&gt; posts to the thread pool, so its reports arrive out of order).</summary>
internal sealed class SyncProgress<T>(Action<T> report) : IProgress<T>
{
    public void Report(T value) => report(value);
}

/// <summary>Where an image's XDVDFS game partition is, and what the image is.</summary>
internal sealed record Located(VolumeInfo Volume, int? SkipSectors)
{
    /// <summary>The game partition is not at the start of the file: a full (Redump) disc dump with a video partition.</summary>
    public bool IsRedump => Volume.DiscLseek != 0 || SkipSectors is > 0;

    public long PartitionOffset => SkipSectors is { } skip ? skip * 2048L : Volume.DiscLseek;

    /// <summary>
    /// The partition offset in sectors for a Redump image, passed to the readers explicitly: their own probing
    /// reads every known offset in turn and fails on an image shorter than one of them.
    /// </summary>
    public int? ReadSkip => IsRedump ? (int)(PartitionOffset / 2048) : null;
}

internal static class Commands
{
    public const string Version = "1.3.0";

    public const string Usage = """
        PlayOutXbox <command> <paths...> [--overwrite]
          trim    <in.iso> <out.iso>     Redump / plain Xbox or Xbox 360 image -> optimized XISO (video partition and
                                         padding removed), verified file-by-file against the source
          extract <image> <outDir>       ISO / CSO / CCI / CHD / ZAR -> folder (unsafe names sanitized), verified
          pack    <inDir> <out.iso>      game folder -> XISO, verified file-by-file against the folder
          zar     <in.iso|inDir> <out.zar>  ISO or folder -> ZArchive (Xenia), verified
          chd     <in.iso> <out.chd>     Xbox DVD -> CHD v5 (chdman createdvd preset), optimized XISO inside, verified
          toiso   <in.chd|in.zar|in.cso|in.cci> <out.iso>  back to a plain ISO, verified
          info    <image>                JSON: format, XGD generation, platform, optimized, title
          read    <in.chd> <offset> <length>  any CHD (CD, DVD, ...): up to 1 MiB of its image, base64 (1.3.0+)
        stdout: one JSON object per line - {"type":"progress","phase":..,"percent":..} while working, then
        {"type":"done",..} or {"type":"error","message":..} (with "refused":true when the input itself is
        refused: not an Xbox image, damaged, wrong kind). stderr: free-form diagnostics.
        Exit 0 = verified success (or skipped), 1 = failed, 2 = usage, 3 = cancelled.
        Outputs are written as <name>.playout-partial<ext> (a folder: <outDir>.playout-partial) and renamed
        into place only after verification; a killed run can leave those behind for the caller to delete.
        """;

    private const string PartialMarker = ".playout-partial";
    private static readonly List<string> LibraryErrors = [];

    public static void RememberLibraryError(string text)
    {
        var line = text.Trim();
        if (line.Length == 0) return;
        lock (LibraryErrors)
        {
            LibraryErrors.Add(line);
            if (LibraryErrors.Count > 8) LibraryErrors.RemoveAt(0);
        }
    }

    private static string LibraryDetail()
    {
        lock (LibraryErrors)
        {
            return LibraryErrors.Count == 0 ? "" : " (" + string.Join("; ", LibraryErrors) + ")";
        }
    }

    public static int Unknown(string command)
    {
        Output.Error($"unknown command '{command}' (--help lists the commands)");
        return 2;
    }

    /// <summary>A refusal of the input (its error line carries "refused":true): the same input is refused again.</summary>
    public static bool IsRefusal(Exception ex) => ex is UserError or XisoFormatException;

    public static string Describe(Exception ex) => ex switch
    {
        UserError user => user.Message,
        XisoFormatException format => "the image is damaged or not an Xbox image: " + format.Message,
        FileNotFoundException { FileName: { } file } when file.StartsWith("Vendored", StringComparison.Ordinal) =>
            $"a file of the Xbox helper is missing ({file.Split(',')[0]}.dll beside PlayOutXbox.exe); reinstall PlayOut",
        IOException io when (io.HResult & 0xFFFF) is 0x70 or 0x27 => "not enough disk space: " + io.Message,
        _ => $"{ex.GetType().Name}: {ex.Message}{LibraryDetail()}"
    };

    // ---------------------------------------------------------------- trim

    public static int Trim(string input, string output, bool overwrite, CancellationToken ct)
    {
        RequireFile(input);
        var kind = Detect(input);
        if (kind != "iso") throw new UserError($"trim needs a plain .iso image, not {kind}");
        var located = Locate(input);
        var identity = Identify(input, located);

        if (!located.IsRedump && XisoReader.IsOptimizedImage(input, null))
        {
            // Nothing to convert, but a damaged image is reported rather than passed as fine.
            var audit = XisoReader.AuditXiso(input, false);
            if (!audit.IsValid)
                throw new UserError("the image is damaged: " + string.Join("; ", audit.Issues.Take(5)));
            Output.Done(w =>
            {
                w.WriteString("skipped", "already optimized");
                identity.Write(w);
            });
            return 0;
        }

        PrepareOutput(input, output, overwrite);
        var partial = PartialFile(output);
        Output.Stages(2); // trim, verify
        try
        {
            RewriteVerified(input, located, partial, "trim", ct);
            Commit(partial, output, overwrite);
        }
        catch
        {
            TryDelete(partial);
            throw;
        }

        Output.Done(w =>
        {
            w.WriteString("output", Path.GetFullPath(output));
            w.WriteNumber("inputBytes", new FileInfo(input).Length);
            w.WriteNumber("outputBytes", new FileInfo(output).Length);
            w.WriteBoolean("redump", located.IsRedump);
            identity.Write(w);
        });
        return 0;
    }

    /// <summary>
    /// Rewrites <paramref name="input"/> into an optimized XISO at <paramref name="target"/> (game partition only,
    /// extract-xiso optimized layout - what XISO Studio's Convert does), then audits it and compares every file
    /// (path, size, SHA-256) with the source. The source is only read.
    /// </summary>
    private static void RewriteVerified(string input, Located located, string target, string phase,
        CancellationToken ct)
    {
        TryDelete(target);
        long total = 0;
        try
        {
            using var image = OpenPartition(input, located);
            total = ImageTree.TotalBytes(ImageTree.FromImage(image, Path.GetFileName(input)));
        }
        catch (Exception)
        {
            // progress then stays at 0 until done; the conversion itself reports real problems
        }

        Output.Progress(phase, 0);
        var sourceLength = new FileInfo(input).Length;
        var sourceWritten = File.GetLastWriteTimeUtc(input);
        var rc = XisoReader.Rewrite(input, Path.GetDirectoryName(target), out var produced, ct,
            outputName: Path.GetFileName(target), skipSectors: located.ReadSkip, prependSectors: null,
            progress: BytesProgress(phase, total), preserveAttributes: false);
        if (!File.Exists(input) || new FileInfo(input).Length != sourceLength ||
            File.GetLastWriteTimeUtc(input) != sourceWritten)
            throw new UserError("the source image changed during the rewrite; stopping");
        if (rc != 0) throw new UserError($"XISOSharp could not rewrite the image (code {rc}){LibraryDetail()}");
        if (produced is not null && !SamePath(produced, target))
        {
            if (!File.Exists(produced)) throw new UserError("XISOSharp produced no output");
            File.Move(produced, target, true);
        }

        if (!File.Exists(target)) throw new UserError("XISOSharp produced no output");
        Output.Progress(phase, 100);
        VerifyImageAgainstSource(input, target, requireOptimized: true);
    }

    private static void VerifyImageAgainstSource(string source, string output, bool requireOptimized)
    {
        Output.Phase("verify");
        var audit = XisoReader.AuditXiso(output, requireOptimized);
        if (!audit.IsValid)
            throw new UserError("the output failed the integrity audit: " + string.Join("; ", audit.Issues.Take(5)));
        var result = XisoValidator.ValidateConversion(source, output, true);
        if (!result.Passed)
            throw new UserError("the output does not match the source: " + string.Join("; ",
                result.Issues.Take(5).Select(i => $"{i.Type} {i.Path}")));
        Output.Progress("verify", 100);
    }

    // ---------------------------------------------------------------- extract

    public static int Extract(string input, string outDir, bool overwrite, CancellationToken ct)
    {
        RequireFile(input);
        var kind = Detect(input);
        var final = Path.GetFullPath(outDir);
        if (File.Exists(final)) throw new UserError($"{final} is a file");
        if (Directory.Exists(final) && Directory.EnumerateFileSystemEntries(final).Any())
            throw new UserError($"{final} already exists and is not empty");
        var partial = final.TrimEnd('\\', '/') + PartialMarker;
        if (Directory.Exists(partial)) Directory.Delete(partial, true);

        int files;
        long bytes;
        int renamed;
        Output.Stages(2);
        try
        {
            if (kind == "zar")
            {
                var expected = ImageTree.MapForExtract(ImageTree.EntriesOfZar(input));
                renamed = expected.Renamed;
                (files, bytes) = (expected.Files.Count, expected.Files.Sum(f => f.File.Size));
                Output.Progress("extract", 0);
                var rc = XisoZarchive.ExtractZar(input, partial, ExtractNamePolicy.Sanitize, false,
                    BytesProgress("extract", bytes), ct, null, null);
                if (rc != 0) throw new UserError($"could not extract the ZArchive (code {rc}){LibraryDetail()}");
                VerifyFolder(partial, expected.Files, p => ImageTree.HashZar(input, p), ct);
            }
            else
            {
                using var image = OpenImage(input, kind, ct);
                var name = Path.GetFileName(input);
                var expected = ImageTree.MapForExtract(ImageTree.EntriesOfImage(image, name));
                renamed = expected.Renamed;
                (files, bytes) = (expected.Files.Count, expected.Files.Sum(f => f.File.Size));
                Output.Progress("extract", 0);
                var rc = XisoReader.UnpackImage(image, name, partial, ct, null,
                    new UnpackOptions { NamePolicy = ExtractNamePolicy.Sanitize }, BytesProgress("extract", bytes));
                if (rc != 0) throw new UserError($"could not extract the image (code {rc}){LibraryDetail()}");
                VerifyFolder(partial, expected.Files, p => ImageTree.HashImage(image, name, p), ct);
            }

            // The folder was checked to be absent or empty before the work; anything there now is not ours.
            if (File.Exists(final) ||
                (Directory.Exists(final) && Directory.EnumerateFileSystemEntries(final).Any()))
                throw new UserError($"{outDir} appeared during the conversion");
            if (Directory.Exists(final)) Directory.Delete(final);
            Directory.Move(partial, final);
        }
        catch
        {
            TryDeleteDir(partial);
            throw;
        }

        Output.Done(w =>
        {
            w.WriteString("output", final);
            w.WriteNumber("files", files);
            w.WriteNumber("bytes", bytes);
            w.WriteNumber("renamed", renamed);
        });
        return 0;
    }

    /// <summary>
    /// Checks an extracted folder against the source tree: the same number of files, and every source file at the
    /// host path its (sanitized) name maps to, with the source's size and SHA-256. Nothing is left unchecked.
    /// </summary>
    private static void VerifyFolder(string folder, List<(TreeFile File, string HostRelative)> expected,
        Func<string, string?> sourceHash, CancellationToken ct)
    {
        Output.Phase("verify");
        var actual = ImageTree.FromFolder(folder);
        long expectedBytes = expected.Sum(f => f.File.Size);
        if (actual.Count != expected.Count || ImageTree.TotalBytes(actual) != expectedBytes)
            throw new UserError($"extracted {actual.Count} files / {ImageTree.TotalBytes(actual)} bytes, " +
                                $"expected {expected.Count} / {expectedBytes}");
        long total = Math.Max(1, expectedBytes), done = 0;
        foreach (var (file, relative) in expected)
        {
            ct.ThrowIfCancellationRequested();
            var host = Path.Combine(folder, relative);
            if (!File.Exists(host)) throw new UserError($"missing after extraction: {file.Path}");
            if (new FileInfo(host).Length != file.Size) throw new UserError($"size differs: {file.Path}");
            if (!string.Equals(ImageTree.HashHost(host), sourceHash(file.Path), StringComparison.OrdinalIgnoreCase))
                throw new UserError($"content differs: {file.Path}");
            done += file.Size;
            Output.Progress("verify", done * 100.0 / total);
        }
    }

    // ---------------------------------------------------------------- pack

    /// <summary>
    /// A game folder (an extracted Xbox / Xbox 360 disc) back into an XISO (XisoWriter, extract-xiso's layout), then
    /// audited and compared with the folder: same files and sizes, and the SHA-256 of every file.
    /// </summary>
    public static int Pack(string inputDir, string output, bool overwrite, CancellationToken ct)
    {
        if (!Directory.Exists(inputDir)) throw new UserError($"{inputDir} is not a folder");
        var source = Path.GetFullPath(inputDir).TrimEnd('\\', '/');
        var target = Path.GetFullPath(output);
        if (target.StartsWith(source + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new UserError("the image cannot be written inside the folder it is made from");
        PrepareOutput(inputDir, output, overwrite);
        var expected = ImageTree.FromFolder(source);
        if (expected.Count == 0) throw new UserError("the folder holds no files");
        var partial = PartialFile(output);
        TryDelete(partial);
        Output.Stages(2); // pack, verify
        try
        {
            Output.Progress("pack", 0);
            var total = ImageTree.TotalBytes(expected);
            var rc = XisoWriter.PackFromDirectory(source, partial, null, null, ct,
                BytesProgress("pack", total));
            ct.ThrowIfCancellationRequested();
            Check(rc, "pack the folder");
            if (!File.Exists(partial)) throw new UserError("XISOSharp produced no output");

            Output.Phase("verify");
            var audit = XisoReader.AuditXiso(partial, false);
            if (!audit.IsValid)
                throw new UserError("the output failed the integrity audit: " + string.Join("; ", audit.Issues.Take(5)));
            using (var image = XisoReader.OpenImageStream(partial))
            {
                var name = Path.GetFileName(partial);
                var problems = ImageTree.Compare(expected, ImageTree.FromImage(image, name));
                if (problems.Count > 0)
                    throw new UserError("the image does not match the folder: " + string.Join("; ", problems));
                long all = Math.Max(1, total), done = 0;
                foreach (var file in expected)
                {
                    ct.ThrowIfCancellationRequested();
                    var host = Path.Combine(source, file.Path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
                    if (!string.Equals(ImageTree.HashHost(host), ImageTree.HashImage(image, name, file.Path),
                            StringComparison.OrdinalIgnoreCase))
                        throw new UserError($"content differs: {file.Path}");
                    done += file.Size;
                    Output.Progress("verify", done * 100.0 / all);
                }
            }

            Commit(partial, output, overwrite);
        }
        catch
        {
            TryDelete(partial);
            throw;
        }

        Output.Done(w =>
        {
            w.WriteString("output", target);
            w.WriteNumber("files", expected.Count);
            w.WriteNumber("outputBytes", new FileInfo(output).Length);
        });
        return 0;
    }

    // ---------------------------------------------------------------- zar

    public static int Zar(string input, string output, bool overwrite, CancellationToken ct)
    {
        var fromFolder = Directory.Exists(input);
        if (!fromFolder) RequireFile(input);
        PrepareOutput(input, output, overwrite);
        var partial = PartialFile(output);
        TryDelete(partial);
        Identity? identity = null;
        Output.Stages(2); // zar, verify
        try
        {
            var progress = new SyncProgress<ZarProgress>(p => Output.Progress("zar", p.Ratio * 100));
            Output.Progress("zar", 0);
            if (fromFolder)
            {
                var written = ZarPipeline.Pack(input, partial, new ZarPipelineOptions(), progress, ct);
                if (written is null || !File.Exists(partial)) throw new UserError("ZArchiveSharp produced no output");
                Output.Phase("verify");
                var expected = ImageTree.FromFolder(input);
                var problems = ImageTree.Compare(expected, ImageTree.FromZar(partial));
                if (problems.Count > 0) throw new UserError("the archive does not match the folder: " + string.Join("; ", problems));
                long total = Math.Max(1, ImageTree.TotalBytes(expected)), done = 0;
                foreach (var file in expected)
                {
                    var host = Path.Combine(input, file.Path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
                    if (!string.Equals(ImageTree.HashHost(host), ImageTree.HashZar(partial, file.Path),
                            StringComparison.OrdinalIgnoreCase))
                        throw new UserError($"content differs: {file.Path}");
                    done += file.Size;
                    Output.Progress("verify", done * 100.0 / total);
                }
            }
            else
            {
                var kind = Detect(input);
                if (kind != "iso") throw new UserError($"zar needs a plain .iso image or a folder, not {kind}");
                var located = Locate(input);
                identity = Identify(input, located);
                bool ok;
                using (var source = new FileStream(input, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16))
                {
                    ok = XisoZarchive.CreateZar(source, located.PartitionOffset, partial, false, true, ct, null,
                        progress);
                }

                if (!ok || !File.Exists(partial)) throw new UserError($"XISOSharp could not pack the ZArchive{LibraryDetail()}");
                Output.Phase("verify");
                var result = XisoValidator.ValidateConversion(input, partial, true);
                if (!result.Passed)
                    throw new UserError("the archive does not match the image: " + string.Join("; ",
                        result.Issues.Take(5).Select(i => $"{i.Type} {i.Path}")));
            }

            Commit(partial, output, overwrite);
        }
        catch
        {
            TryDelete(partial);
            throw;
        }

        Output.Done(w =>
        {
            w.WriteString("output", Path.GetFullPath(output));
            w.WriteNumber("outputBytes", new FileInfo(output).Length);
            identity?.Write(w);
        });
        return 0;
    }

    // ---------------------------------------------------------------- chd

    private const uint DvdHunkBytes = 4096;
    private const uint DvdUnitBytes = 2048;
    private const string DvdCodecs = "lzma,zlib,huff,flac";

    public static int Chd(string input, string output, bool overwrite, CancellationToken ct)
    {
        RequireFile(input);
        var kind = Detect(input);
        if (kind != "iso") throw new UserError($"chd needs a plain .iso image, not {kind}");
        var located = Locate(input);
        var identity = Identify(input, located);
        PrepareOutput(input, output, overwrite);
        var partial = PartialFile(output);
        TryDelete(partial);
        string? temp = null;
        var codecs = new SortedDictionary<string, int>(StringComparer.Ordinal);
        try
        {
            // The CHD holds the optimized game partition (as XISO Studio does): a Redump or unoptimized image is
            // rewritten (and verified) first, next to the output.
            var source = input;
            var rewrite = located.IsRedump || !XisoReader.IsOptimizedImage(input, null);
            Output.Stages(rewrite ? 4 : 2); // [trim, verify,] chd, verify
            if (rewrite)
            {
                temp = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(output))!,
                    Path.GetFileNameWithoutExtension(output) + PartialMarker + "-source.iso");
                RewriteVerified(input, located, temp, "trim", ct);
                source = temp;
            }

            Output.Progress("chd", 0);
            var options = new ChdEncodeOptions
            {
                Metadata = [MetadataWriter.BuildDvdMetadata()],
                HunkCompleted = h =>
                {
                    lock (codecs)
                    {
                        codecs[h.CodecName] = codecs.GetValueOrDefault(h.CodecName) + 1;
                    }

                    if (h.HunkCount > 0) Output.Progress("chd", (h.HunkIndex + 1) * 100.0 / h.HunkCount);
                }
            };
            using (var raw = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20))
            {
                ChdEncoder.EncodeRaw(raw, partial, DvdHunkBytes, DvdUnitBytes, ChdCodecs.ParseCodecTags(DvdCodecs),
                    options, ct);
            }

            if (!File.Exists(partial)) throw new UserError("CHDSharp produced no output");
            VerifyChd(partial, ct);

            // Same file tree on both sides (the deep check above already proved the bytes match the encoder's input).
            using (var sourceImage = XisoReader.OpenImageStream(source))
            using (var chdImage = OpenChd(partial, ct))
            {
                var problems = ImageTree.Compare(ImageTree.FromImage(sourceImage, Path.GetFileName(source)),
                    ImageTree.FromImage(chdImage, Path.GetFileName(partial)));
                if (problems.Count > 0) throw new UserError("the CHD does not match the image: " + string.Join("; ", problems));
            }

            Commit(partial, output, overwrite);
        }
        catch
        {
            TryDelete(partial);
            throw;
        }
        finally
        {
            if (temp is not null) TryDelete(temp);
        }

        Output.Done(w =>
        {
            w.WriteString("output", Path.GetFullPath(output));
            w.WriteNumber("inputBytes", new FileInfo(input).Length);
            w.WriteNumber("outputBytes", new FileInfo(output).Length);
            w.WriteStartObject("hunkCodecs");
            foreach (var (codec, count) in codecs) w.WriteNumber(codec, count);
            w.WriteEndObject();
            identity.Write(w);
        });
        return 0;
    }

    /// <summary>Full CHD check: every hunk decompressed and the SHA-1 / MD5 compared with the header.</summary>
    private static void VerifyChd(string path, CancellationToken ct)
    {
        Output.Phase("verify");
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20);
        var result = CHDSharp.Chd.CheckFile(stream, Path.GetFileName(path), true,
            new SyncProgress<ChdProgress>(p => Output.Progress("verify", p.Percent)), ct);
        if (!result.IsSuccess) throw new UserError("the CHD failed verification: " + result.Error.GetMessage());
    }

    private static Stream OpenChd(string path, CancellationToken ct)
    {
        var error = CHDSharp.Chd.Classify(path, out var classification);
        if (error != ChdError.Chderrnone) throw new UserError("not a valid CHD: " + error.GetMessage());
        if (!string.Equals(classification, "dvd", StringComparison.Ordinal))
            throw new UserError($"the CHD holds a {classification ?? "unknown"} image, not an Xbox DVD");
        error = ChdFile.Open(path, out var chd, ct);
        if (error != ChdError.Chderrnone || chd is null) throw new UserError("not a valid CHD: " + error.GetMessage());
        chd.ConfigureCache(32);
        chd.ConfigureReadAhead(8);
        error = ChdFile.OpenAsStream(chd, true, out var stream);
        if (error != ChdError.Chderrnone || stream is null)
        {
            chd.Dispose();
            throw new UserError("not a valid CHD: " + error.GetMessage());
        }

        return stream;
    }

    // ---------------------------------------------------------------- read

    /// <summary>The most a single <c>read</c> returns (the caller asks for more in further reads).</summary>
    public const int MaxReadBytes = 1 << 20;

    /// <summary>
    /// A slice of any CHD's decompressed image (CD, DVD, GD-ROM, ...), base64 in the done line: PlayOut reads a disc's
    /// file system through it (a PS2 / PlayStation / PSP serial for its texture packs). A CD's image is its frames of
    /// 2448 bytes (2352 sector + 96 subcode); a DVD's its 2048-byte sectors. Past the end, fewer bytes (or none).
    /// </summary>
    public static int Read(string input, string offsetText, string lengthText, CancellationToken ct)
    {
        RequireFile(input);
        if (!long.TryParse(offsetText, System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture, out var offset))
            throw new UserError("read: the offset must be a whole number of bytes");
        if (!int.TryParse(lengthText, System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture, out var length) || length < 1 ||
            length > MaxReadBytes)
            throw new UserError($"read: the length must be 1 to {MaxReadBytes} bytes");
        if (!CHDSharp.Chd.IsChdFile(input)) throw new UserError("read needs a CHD file");
        var error = CHDSharp.Chd.Classify(input, out var classification);
        if (error != ChdError.Chderrnone) throw new UserError("not a valid CHD: " + error.GetMessage());
        error = ChdFile.Open(input, out var chd, ct);
        if (error != ChdError.Chderrnone || chd is null) throw new UserError("not a valid CHD: " + error.GetMessage());
        using (chd)
        {
            if (chd.RequiresParent) throw new UserError("the CHD needs its parent CHD, which read does not open");
            var total = (long)chd.TotalBytes;
            var count = (int)Math.Clamp(total - offset, 0, length);
            var data = new byte[count];
            if (count > 0)
            {
                error = chd.Read((ulong)offset, data, 0, count, ct);
                if (error != ChdError.Chderrnone) throw new UserError("the CHD could not be read: " + error.GetMessage());
            }

            Output.Done(w =>
            {
                w.WriteString("classification", classification ?? "unknown");
                w.WriteNumber("unitBytes", chd.UnitBytes);
                w.WriteNumber("imageBytes", total);
                w.WriteNumber("offset", offset);
                w.WriteNumber("length", count);
                w.WriteString("data", Convert.ToBase64String(data));
            });
        }

        return 0;
    }

    // ---------------------------------------------------------------- toiso

    public static int ToIso(string input, string output, bool overwrite, CancellationToken ct)
    {
        RequireFile(input);
        var kind = Detect(input);
        PrepareOutput(input, output, overwrite);
        var partial = PartialFile(output);
        TryDelete(partial);
        try
        {
            // A CHD is checked whole first: verify, toiso, verify. The others: toiso, verify.
            Output.Stages(kind == "chd" ? 3 : 2);
            if (kind != "chd") Output.Progress("toiso", 0);
            switch (kind)
            {
                case "chd":
                    VerifyChd(input, ct);
                    using (var image = OpenChd(input, ct))
                    {
                        CopyWithProgress(image, partial, "toiso", ct);
                        image.Position = 0;
                        Output.Phase("verify");
                        var audit = XisoReader.AuditXiso(partial, false);
                        if (!audit.IsValid)
                            throw new UserError("the output failed the integrity audit: " +
                                                string.Join("; ", audit.Issues.Take(5)));
                        using var written = XisoReader.OpenImageStream(partial);
                        var problems = ImageTree.Compare(ImageTree.FromImage(image, Path.GetFileName(input)),
                            ImageTree.FromImage(written, Path.GetFileName(partial)));
                        if (problems.Count > 0) throw new UserError("the ISO does not match the CHD: " + string.Join("; ", problems));
                    }

                    break;
                case "zar":
                    Check(XisoZarchive.ConvertZarToIso(input, partial, true, GenericProgress("toiso"), ct), "unpack the ZArchive");
                    VerifyImageAgainstSource(input, partial, requireOptimized: false);
                    break;
                case "cso":
                    Check(CisoReader.DecompressToIso(input, partial, GenericProgress("toiso"), ct), "decompress the CSO");
                    VerifyImageAgainstSource(input, partial, requireOptimized: false);
                    break;
                case "cci":
                    Check(XisoCci.DecompressToIso(input, partial, true, GenericProgress("toiso"), ct), "decompress the CCI");
                    VerifyImageAgainstSource(input, partial, requireOptimized: false);
                    break;
                default:
                    throw new UserError($"toiso needs a .chd, .zar, .cso or .cci file, not {kind}");
            }

            Commit(partial, output, overwrite);
        }
        catch
        {
            TryDelete(partial);
            throw;
        }

        Output.Done(w =>
        {
            w.WriteString("output", Path.GetFullPath(output));
            w.WriteNumber("outputBytes", new FileInfo(output).Length);
        });
        return 0;
    }

    private static void Check(int rc, string what)
    {
        if (rc != 0) throw new UserError($"XISOSharp could not {what} (code {rc}){LibraryDetail()}");
    }

    private static void CopyWithProgress(Stream source, string target, string phase, CancellationToken ct)
    {
        using var destination = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20,
            FileOptions.SequentialScan);
        var buffer = new byte[1 << 20];
        long total = source.Length, copied = 0;
        int read;
        while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
        {
            ct.ThrowIfCancellationRequested();
            destination.Write(buffer, 0, read);
            copied += read;
            if (total > 0) Output.Progress(phase, copied * 100.0 / total);
        }
    }

    // ---------------------------------------------------------------- info

    public static int Info(string input)
    {
        RequireFile(input);
        var kind = Detect(input);
        var size = new FileInfo(input).Length;
        switch (kind)
        {
            case "zar":
            {
                var root = XisoZarchive.ListZar(input).Select(e => e.Path.TrimStart('/')).ToList();
                var platform = PlatformFromNames(root);
                Output.Done(w =>
                {
                    w.WriteString("format", "zar");
                    w.WriteNumber("sizeBytes", size);
                    WriteOrNull(w, "platform", platform);
                });
                return 0;
            }
            case "iso":
            {
                var located = Locate(input);
                var identity = Identify(input, located);
                var optimized = !located.IsRedump && XisoReader.IsOptimizedImage(input, null);
                Output.Done(w =>
                {
                    w.WriteString("format", located.IsRedump ? "redump" : "xiso");
                    w.WriteNumber("sizeBytes", size);
                    w.WriteBoolean("optimized", optimized);
                    w.WriteNumber("partitionOffset", located.PartitionOffset);
                    identity.Write(w);
                });
                return 0;
            }
            case "chd":
            case "cso":
            case "cci":
            {
                using var image = kind == "chd" ? OpenChd(input, CancellationToken.None) : XisoReader.OpenImageStream(input);
                var name = Path.GetFileName(input);
                var volume = XisoReader.GetVolumeInfo(image, name);
                if (!volume.IsValid) throw new UserError("no Xbox file system inside the " + kind);
                var located = new Located(volume, null);
                var identity = Identify(image, name, located);
                var optimized = !located.IsRedump && XisoReader.IsOptimizedImage(image, null);
                Output.Done(w =>
                {
                    w.WriteString("format", kind);
                    w.WriteNumber("sizeBytes", size);
                    w.WriteNumber("imageBytes", image.Length);
                    w.WriteBoolean("optimized", optimized);
                    w.WriteBoolean("redump", located.IsRedump);
                    identity.Write(w);
                });
                return 0;
            }
            default:
                throw new UserError($"not a supported Xbox image ({kind})");
        }
    }

    // ---------------------------------------------------------------- identification

    /// <summary>XGD generation, platform and title of an image.</summary>
    internal sealed record Identity(int? Xgd, string? Platform, string DiscFormat, string? TitleId, string? TitleName)
    {
        public void Write(Utf8JsonWriter w)
        {
            if (Xgd is { } xgd) w.WriteNumber("xgd", xgd);
            else w.WriteNull("xgd");
            WriteOrNull(w, "platform", Platform);
            w.WriteString("discFormat", DiscFormat);
            WriteOrNull(w, "titleId", TitleId);
            WriteOrNull(w, "titleName", TitleName);
        }
    }

    private static Identity Identify(string path, Located located)
    {
        using var image = OpenPartition(path, located);
        return Identify(image, Path.GetFileName(path), located);
    }

    private static Identity Identify(Stream image, string name, Located located)
    {
        int? xgd = located.Volume.DiscFormat switch
        {
            "XGD1" => 1,
            "GLOBAL (XGD2)" or "XGD2 Hybrid" => 2,
            "XGD3" => 3,
            _ => null
        };
        if (xgd is null && located.SkipSectors is { } skip)
        {
            xgd = (skip * 2048L) switch
            {
                0x18300000 => 1,
                0x02080000 => 3,
                _ => 2
            };
        }

        string? platform = xgd switch
        {
            1 => "xbox",
            2 or 3 => "xbox360",
            _ => null
        };
        string? titleId = null, titleName = null;
        try
        {
            var title = XisoReader.GetTitleInfo(image, name);
            if (title is not null)
            {
                titleId = title.TitleIdHex;
                titleName = string.IsNullOrWhiteSpace(title.TitleName) ? null : title.TitleName.Trim();
                platform = title.Kind == TitleKind.Xex ? "xbox360" : "xbox";
            }
        }
        catch (Exception)
        {
            // a damaged or fake executable: fall back to the root names and the layout
        }

        if (titleId is null)
        {
            try
            {
                platform = PlatformFromNames(XisoReader.ListDirectory(image, name, "/").Select(e => e.Name)) ?? platform;
            }
            catch (Exception)
            {
                // keep the layout's answer
            }
        }

        return new Identity(xgd, platform, located.Volume.DiscFormat, titleId, titleName);
    }

    private static string? PlatformFromNames(IEnumerable<string> rootNames)
    {
        var names = rootNames.Select(n => n.ToLowerInvariant()).ToHashSet();
        if (names.Contains("default.xex")) return "xbox360";
        if (names.Contains("default.xbe")) return "xbox";
        return null;
    }

    /// <summary>
    /// Finds the XDVDFS game partition: the library probes the plain, XGD1, XGD2, XGD2-Hybrid and XGD3 offsets;
    /// for a Redump dump whose video partition has a non-standard size, the Redump size and video tables give it.
    /// </summary>
    private static Located Locate(string iso)
    {
        var volume = XisoReader.GetVolumeInfo(iso);
        if (volume.IsValid) return new Located(volume, null);

        var redumpType = XgdTables.GetRedumpIsoTypeBySize(new FileInfo(iso).Length);
        if (redumpType >= 0)
        {
            var videoType = -1;
            try
            {
                using var fs = new FileStream(iso, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16);
                videoType = XgdTables.GetVideoType(fs, redumpType);
            }
            catch (Exception)
            {
                // fall back to the Redump type
            }

            var xisoType = videoType >= 0 ? XgdTables.GetXisoTypeFromVideo(videoType) : XgdTables.GetXgdType(redumpType);
            if (xisoType >= 0 && xisoType < XgdTables.XisoOffset.Length)
            {
                var skip = (int)(XgdTables.XisoOffset[xisoType] / 2048);
                var shifted = XisoReader.GetVolumeInfo(iso, skip);
                if (shifted.IsValid) return new Located(shifted, skip);
            }
        }

        throw new UserError("not an Xbox or Xbox 360 disc image (no XDVDFS file system found)");
    }

    /// <summary>iso, cso, cci, zar, chd, god or unknown (by content, falling back on the extension).</summary>
    private static string Detect(string path)
    {
        if (CHDSharp.Chd.IsChdFile(path)) return "chd";
        if (path.EndsWith(".zar", StringComparison.OrdinalIgnoreCase)) return "zar";
        if (XisoImageSource.TryDetect(path, out var info) && info is not null)
        {
            return info.Format switch
            {
                XisoImageFormat.Ciso or XisoImageFormat.SplitCiso => "cso",
                XisoImageFormat.Cci or XisoImageFormat.SplitCci => "cci",
                XisoImageFormat.Zar => "zar",
                XisoImageFormat.God => "god",
                _ => "iso"
            };
        }

        return "iso";
    }

    /// <summary>The image's game partition as a plain-XISO stream (a Redump image is read from its partition on).</summary>
    private static Stream OpenPartition(string path, Located located)
    {
        if (!located.IsRedump) return XisoReader.OpenImageStream(path);
        var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16);
        return new OffsetStream(file, located.PartitionOffset);
    }

    private static Stream OpenImage(string path, string kind, CancellationToken ct) =>
        kind switch
        {
            "chd" => OpenChd(path, ct),
            "iso" => OpenPartition(path, Locate(path)),
            "cso" or "cci" => XisoReader.OpenImageStream(path),
            _ => throw new UserError($"not a supported Xbox image ({kind})")
        };

    // ---------------------------------------------------------------- progress

    /// <summary>Byte progress of rewrite / unpack events against the image's total file bytes.</summary>
    private static IProgress<ProgressInfo> BytesProgress(string phase, long total)
    {
        long done = 0;
        return new SyncProgress<ProgressInfo>(info =>
        {
            if (total <= 0) return;
            switch (info.Type)
            {
                case ProgressInfoType.FileAdded:
                    done += (long)info.Size;
                    Output.Progress(phase, done * 100.0 / total);
                    break;
                case ProgressInfoType.FileProgress:
                    Output.Progress(phase, (done + (long)info.Size) * 100.0 / total);
                    break;
            }
        });
    }

    /// <summary>Container progress: per-sector FileAdded against a FileCount total, or FileProgress bytes.</summary>
    private static IProgress<ProgressInfo> GenericProgress(string phase)
    {
        long sectors = 0;
        return new SyncProgress<ProgressInfo>(info =>
        {
            switch (info.Type)
            {
                case ProgressInfoType.FileCount:
                    sectors = (long)info.Count;
                    break;
                case ProgressInfoType.FileAdded when sectors > 0:
                    Output.Progress(phase, info.Sector * 100.0 / sectors);
                    break;
                case ProgressInfoType.FileProgress when info.Count > 0:
                    Output.Progress(phase, (double)info.Size * 100.0 / info.Count);
                    break;
            }
        });
    }

    // ---------------------------------------------------------------- files

    private static void RequireFile(string path)
    {
        if (!File.Exists(path)) throw new UserError($"{path} not found");
    }

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);

    private static void PrepareOutput(string input, string output, bool overwrite)
    {
        if (SamePath(input, output)) throw new UserError("the output would replace the source");
        if (Directory.Exists(output)) throw new UserError($"{output} is a folder");
        if (File.Exists(output) && !overwrite)
            throw new UserError($"{output} already exists (pass --overwrite to replace it)");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
    }

    /// <summary>"game.iso" -> "game.playout-partial.iso": keeps the extension the libraries detect formats by.</summary>
    private static string PartialFile(string output)
    {
        var full = Path.GetFullPath(output);
        return Path.Combine(Path.GetDirectoryName(full)!,
            Path.GetFileNameWithoutExtension(full) + PartialMarker + Path.GetExtension(full));
    }

    /// <summary>
    /// The verified partial takes the output's name. Without --overwrite an output that appeared while the work ran
    /// (it was checked to be absent first) is never replaced: the partial goes and the run fails.
    /// </summary>
    private static void Commit(string partial, string output, bool overwrite)
    {
        var final = Path.GetFullPath(output);
        if (!overwrite && (File.Exists(final) || Directory.Exists(final)))
        {
            TryDelete(partial);
            throw new UserError($"{output} appeared during the conversion");
        }

        try
        {
            File.Move(partial, final, overwrite);
        }
        catch (IOException) when (!overwrite && (File.Exists(final) || Directory.Exists(final)))
        {
            TryDelete(partial);
            throw new UserError($"{output} appeared during the conversion");
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception)
        {
            // left for PlayOut's partial-file cleanup
        }
    }

    private static void TryDeleteDir(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, true);
        }
        catch (Exception)
        {
            // left for PlayOut's partial-file cleanup
        }
    }

    private static void WriteOrNull(Utf8JsonWriter w, string name, string? value)
    {
        if (value is null) w.WriteNull(name);
        else w.WriteString(name, value);
    }
}
