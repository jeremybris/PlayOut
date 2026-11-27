// PlayOut Xbox helper: Xbox / Xbox 360 disc image conversions for PlayOut, built on the MIT-licensed
// XISOSharp (with CCISharp, ZArchiveSharp, StfsSharp) and CHDSharp libraries by purelogiccode - the engine
// behind XISO Studio. Every command writes JSON lines on stdout (see Output) and exits 0 only after its
// output has been verified; outputs are written under a ".playout-partial" name and renamed into place last,
// so an interrupted run never leaves a file that looks finished.
using PlayOutXbox;
using XISOSharp;

Output.Init();
Logger.Quiet = true;
Logger.RemoveSystemUpdate = false;
// No .xbe media-enable patching (extract-xiso's default, which XISO Studio keeps): emulators do not need it, and
// leaving every file byte-identical to the disc is what lets each conversion be verified with SHA-256 per file.
Logger.MediaEnable = false;
Logger.ForwardError = Commands.RememberLibraryError;
Logger.ForwardWarning = Commands.RememberLibraryError;

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cts.Cancel();
};

var positional = args.Where(a => !a.StartsWith("--", StringComparison.Ordinal)).ToList();
var overwrite = args.Contains("--overwrite");

if (args.Contains("--version"))
{
    Output.Done(w => w.WriteString("version", Commands.Version));
    return 0;
}

if (args.Contains("--help") || args.Contains("-h"))
{
    Console.Error.WriteLine(Commands.Usage);
    return 0;
}

if (positional.Count == 0)
{
    Output.Error("no command (--help lists the commands)");
    return 2;
}

var command = positional[0].ToLowerInvariant();
var operands = positional.Skip(1).ToList();
int Need(int count)
{
    if (operands.Count == count) return 0;
    Output.Error($"'{command}' takes {count} path(s) (--help lists the commands)");
    return 2;
}

try
{
    var token = cts.Token;
    return command switch
    {
        "trim" => Need(2) != 0 ? 2 : Commands.Trim(operands[0], operands[1], overwrite, token),
        "extract" => Need(2) != 0 ? 2 : Commands.Extract(operands[0], operands[1], overwrite, token),
        "pack" => Need(2) != 0 ? 2 : Commands.Pack(operands[0], operands[1], overwrite, token),
        "zar" => Need(2) != 0 ? 2 : Commands.Zar(operands[0], operands[1], overwrite, token),
        "chd" => Need(2) != 0 ? 2 : Commands.Chd(operands[0], operands[1], overwrite, token),
        "toiso" => Need(2) != 0 ? 2 : Commands.ToIso(operands[0], operands[1], overwrite, token),
        "info" => Need(1) != 0 ? 2 : Commands.Info(operands[0]),
        "read" => Need(3) != 0 ? 2 : Commands.Read(operands[0], operands[1], operands[2], token),
        _ => Commands.Unknown(command)
    };
}
catch (OperationCanceledException)
{
    Output.Error("cancelled");
    return 3;
}
catch (Exception ex)
{
    if (ex is not UserError) Console.Error.WriteLine(ex); // stderr carries the details for logs
    Output.Error(Commands.Describe(ex), Commands.IsRefusal(ex));
    return 1;
}
