# Builds the pictures of Filters > Genre for the genres no line icon fits (src/renderer/src/assets/genre-icons) from
# the user's Desktop "Icons" folder, as masks ("<id>.mask.png": white, the drawing in the alpha) that GenreIcon paints
# in the text colour, so they look like the line icons around them (the user asked for the colours to match). Kinds:
#   ink        - a drawing with dark lines: the dark pixels are the drawing; a white or checkerboard background and
#                light colour fills drop out. -Dark sets how dark a pixel must be to count fully (lower = only the
#                outlines of a coloured drawing).
#   silhouette - a flat coloured picture without outlines: its whole shape is the drawing (-WhiteBg first clears the
#                white around it), with -Holes cutting out pixels of a colour (Metroidvania's visor).
# Each is trimmed to its drawing and fitted into 96 x 96; -Thicken (pixels at 96) then widens thin lines to about the
# line icons' stroke, so they are not faint at menu size.
# Without the Icons folder, the pictures already built are the source (copied aside first): a mask's own alpha is its
# drawing, and a coloured one built before 0.9.67 goes through its kind as above.
#   powershell -ExecutionPolicy Bypass -File scripts/build-genre-icons.ps1 [-Source "<folder>"]
param([string]$Source = "$env:USERPROFILE\Desktop\Icons")
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class GenreIconBuild {
  static byte[] Read(Bitmap b) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var px = new byte[d.Stride * b.Height];
    Marshal.Copy(d.Scan0, px, 0, px.Length);
    b.UnlockBits(d);
    return px;
  }
  static Bitmap Write(byte[] px, int w, int h) {
    var b = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    var d = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    Marshal.Copy(px, 0, d.Scan0, px.Length);
    b.UnlockBits(d);
    return b;
  }
  // Dark pixels become opaque white; light ones (background, light fills) transparent. Full ink at `dark` and below,
  // none from `dark` + 80 up.
  public static Bitmap Ink(Bitmap src, double dark) {
    int w = src.Width, h = src.Height;
    var px = Read(src);
    for (int i = 0; i < px.Length; i += 4) {
      double lum = 0.114 * px[i] + 0.587 * px[i + 1] + 0.299 * px[i + 2];
      double ink = Math.Max(0, Math.Min(1, (dark + 80 - lum) / 80));
      px[i] = px[i + 1] = px[i + 2] = 255;
      px[i + 3] = (byte)Math.Round(px[i + 3] * ink);
    }
    return Write(px, w, h);
  }
  // An already built mask: its alpha is the drawing (only made white again).
  public static Bitmap Alpha(Bitmap src) {
    int w = src.Width, h = src.Height;
    var px = Read(src);
    for (int i = 0; i < px.Length; i += 4) px[i] = px[i + 1] = px[i + 2] = 255;
    return Write(px, w, h);
  }
  // The whole shape becomes opaque white; with `holes`, pixels of that colour (green / yellow) are cut out.
  public static Bitmap Silhouette(Bitmap src, string holes) {
    int w = src.Width, h = src.Height;
    var px = Read(src);
    for (int i = 0; i < px.Length; i += 4) {
      int b = px[i], g = px[i + 1], r = px[i + 2];
      bool hole = false;
      if (holes == "green-yellow") hole = (g > r + 40 && g > b + 40) || (r > 200 && g > 200 && b < 120);
      px[i] = px[i + 1] = px[i + 2] = 255;
      if (hole) px[i + 3] = 0;
    }
    return Write(px, w, h);
  }
  // White reached from the edges becomes transparent (the picture's own whites inside stay).
  public static Bitmap ClearWhiteBg(Bitmap src) {
    int w = src.Width, h = src.Height;
    var px = Read(src);
    var seen = new bool[w * h];
    var q = new Queue<int>();
    Func<int, bool> white = p => px[p * 4 + 3] > 0 && px[p * 4] > 232 && px[p * 4 + 1] > 232 && px[p * 4 + 2] > 232;
    for (int x = 0; x < w; x++) { q.Enqueue(x); q.Enqueue((h - 1) * w + x); }
    for (int y = 0; y < h; y++) { q.Enqueue(y * w); q.Enqueue(y * w + w - 1); }
    while (q.Count > 0) {
      int p = q.Dequeue();
      if (seen[p] || !white(p)) continue;
      seen[p] = true;
      px[p * 4 + 3] = 0;
      int x = p % w, y = p / w;
      if (x > 0) q.Enqueue(p - 1);
      if (x < w - 1) q.Enqueue(p + 1);
      if (y > 0) q.Enqueue(p - w);
      if (y < h - 1) q.Enqueue(p + w);
    }
    return Write(px, w, h);
  }
  // The box around every pixel more than faintly visible.
  public static Rectangle Bounds(Bitmap src) {
    int w = src.Width, h = src.Height, x0 = w, y0 = h, x1 = -1, y1 = -1;
    var px = Read(src);
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] <= 24) continue;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    return x1 < 0 ? new Rectangle(0, 0, w, h) : new Rectangle(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }
  // Widens the drawing by `radius` pixels (each pixel takes the strongest alpha within that distance; the fraction of
  // a pixel at the rim is blended, so the edge stays smooth).
  public static Bitmap Thicken(Bitmap src, double radius) {
    if (radius <= 0) return src;
    int w = src.Width, h = src.Height, r = (int)Math.Ceiling(radius);
    var px = Read(src);
    var outp = (byte[])px.Clone();
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      double best = px[(y * w + x) * 4 + 3];
      for (int dy = -r; dy <= r; dy++) for (int dx = -r; dx <= r; dx++) {
        int sx = x + dx, sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        double d = Math.Sqrt(dx * dx + dy * dy);
        double reach = Math.Max(0, Math.Min(1, radius + 0.5 - d));
        double a = px[(sy * w + sx) * 4 + 3] * reach;
        if (a > best) best = a;
      }
      outp[(y * w + x) * 4] = outp[(y * w + x) * 4 + 1] = outp[(y * w + x) * 4 + 2] = 255;
      outp[(y * w + x) * 4 + 3] = (byte)Math.Round(best);
    }
    return Write(outp, w, h);
  }
}
'@
$root = Split-Path $PSScriptRoot -Parent
$size = 96
# Genre id (lib/steamTags.ts TAG_FILTERS) -> picture, kind and tuning. Roguelike is drawn in GenreIcon.tsx instead
# (the picture the user found is a watermarked stock preview).
$genres = [ordered]@{
  '2d'                = @{ file = '2D.png'; kind = 'ink'; dark = 110; thicken = 0 }
  'anime'             = @{ file = 'Anime.png'; kind = 'ink'; dark = 110; thicken = 1.5 }
  'immersive sim'     = @{ file = 'Immersive Sim.png'; kind = 'ink'; dark = 110; thicken = 2 }
  'minimalist'        = @{ file = 'Minimalist.png'; kind = 'ink'; dark = 110; thicken = 1.5 }
  'puzzle platformer' = @{ file = 'Puzzle Platformer.png'; kind = 'ink'; dark = 110; thicken = 1.2 }
  'shooter'           = @{ file = 'shooter.png'; kind = 'ink'; dark = 110; thicken = 1 }
  'jrpg'              = @{ file = 'JRPG.png'; kind = 'ink'; dark = 60; thicken = 0.8 }
  'platformer'        = @{ file = 'Platformer.png'; kind = 'ink'; dark = 60; thicken = 0.8 }
  'metroidvania'      = @{ file = 'Metroidvania.png'; kind = 'silhouette'; holes = 'green-yellow'; thicken = 0 }
  'rts'               = @{ file = 'RTS.png'; kind = 'silhouette'; whiteBg = $true; thicken = 0 }
}
$outDir = Join-Path $root 'src\renderer\src\assets\genre-icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$fromBuilt = -not (Test-Path -LiteralPath $Source)
if ($fromBuilt) {
  $Source = Join-Path $env:TEMP 'playout-genre-icons-source'
  Remove-Item -Recurse -Force -LiteralPath $Source -ErrorAction SilentlyContinue
  Copy-Item -Recurse -LiteralPath $outDir -Destination $Source
  "Icons folder not found: rebuilding from the pictures already built"
}
# Check every picture is there before clearing the old ones.
foreach ($id in $genres.Keys) {
  $slug = ($id -replace '[^a-z0-9]+', '-')
  $ok = if ($fromBuilt) { (Test-Path (Join-Path $Source "$slug.png")) -or (Test-Path (Join-Path $Source "$slug.mask.png")) }
        else { Test-Path -LiteralPath (Join-Path $Source $genres[$id].file) }
  if (-not $ok) { throw "missing picture for $id in $Source" }
}
Get-ChildItem $outDir -Filter *.png | Remove-Item -Force
foreach ($id in $genres.Keys) {
  $g = $genres[$id]
  $slug = ($id -replace '[^a-z0-9]+', '-')
  $kind = $g.kind
  if ($fromBuilt) {
    $path = Join-Path $Source "$slug.png"
    if (-not (Test-Path -LiteralPath $path)) { $path = Join-Path $Source "$slug.mask.png"; $kind = 'alpha' }
  } else { $path = Join-Path $Source $g.file }
  $loaded = [System.Drawing.Image]::FromFile($path)
  $img = New-Object System.Drawing.Bitmap $loaded
  $loaded.Dispose()
  if ($g.whiteBg -and $kind -ne 'alpha') { $img = [GenreIconBuild]::ClearWhiteBg($img) }
  if ($kind -eq 'alpha') { $img = [GenreIconBuild]::Alpha($img) }
  elseif ($kind -eq 'ink') { $img = [GenreIconBuild]::Ink($img, [double]$g.dark) }
  else { $img = [GenreIconBuild]::Silhouette($img, [string]$g.holes) }
  $box = [GenreIconBuild]::Bounds($img)
  # Leave room for the thickening at the edges.
  $inner = $size - 2 * [math]::Ceiling([double]$g.thicken)
  $scale = [math]::Min($inner / $box.Width, $inner / $box.Height)
  $w = [int][math]::Round($box.Width * $scale); $h = [int][math]::Round($box.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gr = [System.Drawing.Graphics]::FromImage($bmp)
  $gr.Clear([System.Drawing.Color]::Transparent)
  $gr.InterpolationMode = 'HighQualityBicubic'; $gr.SmoothingMode = 'HighQuality'; $gr.PixelOffsetMode = 'HighQuality'
  $gr.CompositingQuality = 'HighQuality'
  $dest = New-Object System.Drawing.Rectangle ([int](($size - $w) / 2)), ([int](($size - $h) / 2)), $w, $h
  $gr.DrawImage($img, $dest, $box, [System.Drawing.GraphicsUnit]::Pixel)
  $gr.Dispose(); $img.Dispose()
  $out = [GenreIconBuild]::Thicken($bmp, [double]$g.thicken)
  $out.Save((Join-Path $outDir "$slug.mask.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose(); if ($out -ne $bmp) { $bmp.Dispose() }
  "$($g.file) -> $slug.mask.png"
}
