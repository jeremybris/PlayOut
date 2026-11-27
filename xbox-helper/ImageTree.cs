using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using System.Security.Cryptography;
using XISOSharp;
using XISOSharp.Models;

namespace PlayOutXbox;

/// <summary>One file of an image or folder tree: forward-slash path from the root, size.</summary>
internal sealed record TreeFile(string Path, long Size);

/// <summary>One entry of an image or archive tree, folders included (size 0 for a folder).</summary>
internal sealed record TreeEntry(string Path, bool IsDirectory, long Size);

/// <summary>
/// Walks the file trees of images (through a seekable image stream, so plain/Redump ISO, CSO, CCI and CHD
/// all work the same way), ZArchives and host folders, and hashes their files, for the post-conversion checks.
/// </summary>
internal static class ImageTree
{
    public static List<TreeFile> FromImage(Stream image, string name)
    {
        var files = new List<TreeFile>();
        var pending = new Stack<string>();
        pending.Push("/");
        while (pending.Count > 0)
        {
            var dir = pending.Pop();
            foreach (var entry in XisoReader.ListDirectory(image, name, dir))
            {
                var path = dir == "/" ? "/" + entry.Name : dir + "/" + entry.Name;
                if (entry.IsDirectory) pending.Push(path);
                else files.Add(new TreeFile(path, entry.FileSize));
            }
        }

        return files;
    }

    /// <summary>Every entry (folders too) of an image, each folder's entries in listing order, parents first.</summary>
    public static List<TreeEntry> EntriesOfImage(Stream image, string name)
    {
        var entries = new List<TreeEntry>();
        var pending = new Stack<string>();
        pending.Push("/");
        while (pending.Count > 0)
        {
            var dir = pending.Pop();
            foreach (var entry in XisoReader.ListDirectory(image, name, dir))
            {
                var path = dir == "/" ? "/" + entry.Name : dir + "/" + entry.Name;
                entries.Add(new TreeEntry(path, entry.IsDirectory, entry.IsDirectory ? 0 : entry.FileSize));
                if (entry.IsDirectory) pending.Push(path);
            }
        }

        return entries;
    }

    /// <summary>Every entry (folders too) of a ZArchive, in its listing order.</summary>
    public static List<TreeEntry> EntriesOfZar(string zarPath) =>
        XisoZarchive.ListZar(zarPath)
            .Select(e => new TreeEntry("/" + e.Path.Trim('/'), e.IsDirectory, e.IsDirectory ? 0 : (long)e.Size))
            .ToList();

    private delegate bool ResolveName(string name, ExtractNamePolicy policy, HashSet<string> usedNames,
        out string resolvedName, out bool changed);

    /// <summary>
    /// XISOSharp's own extraction-name resolver (internal XisoEntryNames.TryResolveExtractionName, the code its
    /// extract walkers run), so the check maps names exactly as the extraction did. Bound once; the trimmer keeps it.
    /// </summary>
    private static readonly Lazy<ResolveName> Resolver = new(() =>
    {
        var type = Type.GetType("XISOSharp.XisoEntryNames, XISOSharp", true)!;
        var method = type.GetMethod("TryResolveExtractionName", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic,
            [typeof(string), typeof(ExtractNamePolicy), typeof(HashSet<string>), typeof(string).MakeByRefType(),
                typeof(bool).MakeByRefType()]);
        if (method is null)
            throw new UserError("this build of the Xbox helper cannot map extracted names (XISOSharp changed)");
        return method.CreateDelegate<ResolveName>();
    });

    [DynamicDependency(DynamicallyAccessedMemberTypes.PublicMethods | DynamicallyAccessedMemberTypes.NonPublicMethods,
        "XISOSharp.XisoEntryNames", "XISOSharp")]
    private static bool ResolveExtractionName(string name, ExtractNamePolicy policy, HashSet<string> used,
        out string resolved, out bool changed) =>
        Resolver.Value(name, policy, used, out resolved, out changed);

    /// <summary>
    /// Where each file of a source tree lands when it is extracted with <see cref="ExtractNamePolicy.Sanitize"/>:
    /// every path component goes through XISOSharp's own extraction-name resolver (unsafe characters replaced,
    /// <c>~N</c> on a collision within its folder), folder by folder in listing order as the extractor walks them.
    /// <c>Renamed</c> counts the components whose name actually changed (a renamed folder once).
    /// </summary>
    public static (List<(TreeFile File, string HostRelative)> Files, int Renamed) MapForExtract(
        IReadOnlyList<TreeEntry> entries)
    {
        var used = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var host = new Dictionary<string, string>(StringComparer.Ordinal) { ["/"] = "" };
        var renamed = 0;

        string Resolve(string path)
        {
            if (host.TryGetValue(path, out var known)) return known;
            var cut = path.LastIndexOf('/');
            var parent = cut <= 0 ? "/" : path[..cut];
            var parentHost = Resolve(parent);
            var name = path[(cut + 1)..];
            if (!used.TryGetValue(parent, out var names))
                used[parent] = names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (!ResolveExtractionName(name, ExtractNamePolicy.Sanitize, names, out var resolved, out _))
                throw new UserError($"the extractor would skip {path}");
            if (!string.Equals(resolved, name, StringComparison.Ordinal)) renamed++;
            var mapped = parentHost.Length == 0 ? resolved : parentHost + System.IO.Path.DirectorySeparatorChar + resolved;
            host[path] = mapped;
            return mapped;
        }

        var files = new List<(TreeFile, string)>();
        foreach (var entry in entries)
        {
            var mapped = Resolve(entry.Path);
            if (!entry.IsDirectory) files.Add((new TreeFile(entry.Path, entry.Size), mapped));
        }

        return (files, renamed);
    }

    public static List<TreeFile> FromZar(string zarPath) =>
        XisoZarchive.ListZar(zarPath)
            .Where(e => !e.IsDirectory)
            .Select(e => new TreeFile(e.Path, (long)e.Size))
            .ToList();

    public static List<TreeFile> FromFolder(string root)
    {
        var full = Path.GetFullPath(root);
        return Directory.EnumerateFiles(full, "*", SearchOption.AllDirectories)
            .Select(f => new TreeFile("/" + Path.GetRelativePath(full, f).Replace('\\', '/'), new FileInfo(f).Length))
            .ToList();
    }

    public static long TotalBytes(IEnumerable<TreeFile> files) => files.Sum(f => f.Size);

    public static string HashHost(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    public static string? HashImage(Stream image, string name, string internalPath)
    {
        var hash = XisoReader.ComputeFileHash(image, name, internalPath, HashAlgorithmName.SHA256);
        return hash is null ? null : Convert.ToHexString(hash);
    }

    public static string? HashZar(string zarPath, string internalPath)
    {
        var hash = XisoZarchive.ComputeFileHash(zarPath, internalPath, HashAlgorithmName.SHA256);
        return hash is null ? null : Convert.ToHexString(hash);
    }

    /// <summary>
    /// Compares two trees by path (case-insensitive, as XDVDFS and ZArchive are) and size. Returns the
    /// differences, at most <paramref name="limit"/> of them.
    /// </summary>
    public static List<string> Compare(IReadOnlyList<TreeFile> expected, IReadOnlyList<TreeFile> actual, int limit = 20)
    {
        var problems = new List<string>();
        var byPath = new Dictionary<string, TreeFile>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in actual) byPath[file.Path] = file;
        foreach (var file in expected)
        {
            if (problems.Count >= limit) break;
            if (!byPath.Remove(file.Path, out var match)) problems.Add($"missing {file.Path}");
            else if (match.Size != file.Size)
                problems.Add($"size differs {file.Path}: {file.Size} vs {match.Size}");
        }

        foreach (var extra in byPath.Keys)
        {
            if (problems.Count >= limit) break;
            problems.Add($"unexpected {extra}");
        }

        return problems;
    }
}

/// <summary>
/// A read-only view of a file from <paramref name="offset"/> on: a Redump image's game partition then reads as
/// a plain XISO, so the libraries need not probe the disc offsets (their probing reads past the end of images
/// shorter than the largest known offset).
/// </summary>
internal sealed class OffsetStream(Stream inner, long offset) : Stream
{
    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => Math.Max(0, inner.Length - offset);

    public override long Position
    {
        get => inner.Position - offset;
        set => inner.Position = value + offset;
    }

    public override int Read(byte[] buffer, int index, int count) => inner.Read(buffer, index, count);
    public override int Read(Span<byte> buffer) => inner.Read(buffer);

    public override long Seek(long position, SeekOrigin origin) => origin switch
    {
        SeekOrigin.Begin => inner.Seek(position + offset, SeekOrigin.Begin) - offset,
        SeekOrigin.Current => inner.Seek(position, SeekOrigin.Current) - offset,
        _ => inner.Seek(position, SeekOrigin.End) - offset
    };

    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int index, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing) inner.Dispose();
        base.Dispose(disposing);
    }
}
