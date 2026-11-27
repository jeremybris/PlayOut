using System.Text;
using System.Text.Json;

namespace PlayOutXbox;

/// <summary>
/// Machine-readable output: one JSON object per line on the real stdout. The libraries log to
/// <see cref="Console.Out"/>, so <see cref="Init"/> points Console.Out at stderr and keeps the original
/// stdout for these lines only (PlayOut parses every stdout line as JSON).
/// </summary>
internal static class Output
{
    private static TextWriter _stdout = Console.Out;
    private static readonly Lock Gate = new();
    private static int _lastPercent = -1;
    private static string? _lastPhase;
    private static int _stages = 1;
    private static int _stage;
    private static int _lastOverall;

    // Plain UTF-8 and no HTML-safe escaping of ' < > (the lines are parsed as JSON, never embedded in a page).
    private static readonly JsonWriterOptions WriterOptions =
        new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static void Init()
    {
        _stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        Console.SetOut(Console.Error);
    }

    /// <summary>
    /// How many phases the command runs (trim, verify, chd, verify = 4): each phase change is the next stage, and
    /// every progress line carries <c>stage</c>, <c>stages</c> and <c>overall</c> (0-100 across all stages, never
    /// going back), so the caller's bar does not restart at each phase.
    /// </summary>
    public static void Stages(int count)
    {
        lock (Gate)
        {
            _stages = Math.Max(1, count);
        }
    }

    /// <summary>Writes a progress line when the phase changes or the whole percent moves.</summary>
    public static void Progress(string phase, double percent)
    {
        var whole = (int)Math.Clamp(Math.Floor(percent), 0, 100);
        int stage, stages, overall;
        lock (Gate)
        {
            if (phase == _lastPhase && whole <= _lastPercent) return;
            if (phase != _lastPhase) _stage = Math.Min(_stage + 1, _stages);
            _lastPhase = phase;
            _lastPercent = whole;
            stage = Math.Max(1, _stage);
            stages = _stages;
            _lastOverall = Math.Max(_lastOverall, ((stage - 1) * 100 + whole) / stages);
            overall = _lastOverall;
        }

        Line(w =>
        {
            w.WriteString("type", "progress");
            w.WriteString("phase", phase);
            w.WriteNumber("percent", whole);
            w.WriteNumber("stage", stage);
            w.WriteNumber("stages", stages);
            w.WriteNumber("overall", overall);
        });
    }

    /// <summary>A phase whose length is unknown (validation, hashing): percent stays at 0.</summary>
    public static void Phase(string phase) => Progress(phase, 0);

    /// <summary>
    /// The error line. <paramref name="refused"/> marks a refusal of the input itself (not an Xbox image, damaged,
    /// wrong kind): asking again gives the same answer. Without it the failure may be passing (I/O, disk space).
    /// </summary>
    public static void Error(string message, bool refused = false) =>
        Line(w =>
        {
            w.WriteString("type", "error");
            w.WriteString("message", message);
            if (refused) w.WriteBoolean("refused", true);
        });

    public static void Done(Action<Utf8JsonWriter> fields) =>
        Line(w =>
        {
            w.WriteString("type", "done");
            fields(w);
        });

    public static void Line(Action<Utf8JsonWriter> body)
    {
        using var buffer = new MemoryStream();
        using (var w = new Utf8JsonWriter(buffer, WriterOptions))
        {
            w.WriteStartObject();
            body(w);
            w.WriteEndObject();
        }

        var text = Encoding.UTF8.GetString(buffer.ToArray());
        lock (Gate)
        {
            _stdout.WriteLine(text);
        }
    }
}
