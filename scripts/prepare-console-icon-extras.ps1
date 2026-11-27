# Prepares console pictures that come from outside the "HD Video Games" set (the user's Desktop "Platform Icons"
# folder) for scripts/build-console-icons.ps1: reads PNG, JPG and WebP (Windows' own WebP decoder), clears a background
# baked into the picture (a fake transparency checkerboard, or plain white) where it reaches the edges, trims to the
# drawing and saves a 256 px PNG in scripts/console-icons-extra/<name>.png. build-console-icons.ps1 looks there when a
# picture is not in the HD Video Games folder.
#   powershell -ExecutionPolicy Bypass -File scripts/prepare-console-icon-extras.ps1 [-Source "<folder>"]
param([string]$Source = "$env:USERPROFILE\Desktop\Platform Icons")
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName PresentationCore
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class ConsoleIconExtra {
  public static Bitmap FromBgra(byte[] px, int w, int h) {
    var b = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    var d = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    Marshal.Copy(px, 0, d.Scan0, px.Length);
    b.UnlockBits(d);
    return b;
  }
  static byte[] Read(Bitmap b) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var px = new byte[d.Stride * b.Height];
    Marshal.Copy(d.Scan0, px, 0, px.Length);
    b.UnlockBits(d);
    return px;
  }
  // The checkerboard's cell size along the top row (0 = one plain colour), from the first change of shade.
  static int CellSize(byte[] px, int w) {
    int first = px[0];
    for (int x = 1; x < Math.Min(w, 200); x++) if (Math.Abs(px[x * 4] - first) > 6) return x;
    return 0;
  }
  // Clears the background reaching the edges: pixels matching the colour the checkerboard (or the plain backdrop) has
  // at that spot, within `tol`. With `loose`, light grey pixels next to cleared ones go too (a JPG's blurred cell edges)
  // - only for pictures whose drawing has a dark outline, where that cannot eat into the drawing.
  public static Bitmap ClearBackground(Bitmap src, int tol, bool loose) {
    int w = src.Width, h = src.Height;
    var px = Read(src);
    if (px[3] < 16 && px[(w - 1) * 4 + 3] < 16) return src; // real transparency already
    int cell = CellSize(px, w);
    byte c0 = px[0], c1 = c0;
    if (cell > 0) c1 = px[cell * 4];
    Func<int, int, bool> bg = (x, y) => {
      int i = (y * w + x) * 4;
      int expect = cell > 0 && ((x / cell + y / cell) % 2 == 1) ? c1 : c0;
      return Math.Abs(px[i] - expect) <= tol && Math.Abs(px[i + 1] - expect) <= tol && Math.Abs(px[i + 2] - expect) <= tol;
    };
    var seen = new bool[w * h];
    var q = new Queue<int>();
    for (int x = 0; x < w; x++) { q.Enqueue(x); q.Enqueue((h - 1) * w + x); }
    for (int y = 0; y < h; y++) { q.Enqueue(y * w); q.Enqueue(y * w + w - 1); }
    while (q.Count > 0) {
      int p = q.Dequeue();
      if (seen[p]) continue;
      int x = p % w, y = p / w;
      if (!bg(x, y)) continue;
      seen[p] = true;
      if (x > 0) q.Enqueue(p - 1);
      if (x < w - 1) q.Enqueue(p + 1);
      if (y > 0) q.Enqueue(p - w);
      if (y < h - 1) q.Enqueue(p + w);
    }
    if (loose) {
      for (int pass = 0; pass < 3; pass++) {
        var add = new List<int>();
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
          int p = y * w + x;
          if (seen[p]) continue;
          int i = p * 4;
          int mx = Math.Max(px[i], Math.Max(px[i + 1], px[i + 2])), mn = Math.Min(px[i], Math.Min(px[i + 1], px[i + 2]));
          if (mn < 200 || mx - mn > 12) continue;
          bool near = (x > 0 && seen[p - 1]) || (x < w - 1 && seen[p + 1]) || (y > 0 && seen[p - w]) || (y < h - 1 && seen[p + w]);
          if (near) add.Add(p);
        }
        foreach (var p in add) seen[p] = true;
      }
    }
    for (int p = 0; p < w * h; p++) if (seen[p]) px[p * 4 + 3] = 0;
    return FromBgra(px, w, h);
  }
  public static Rectangle Bounds(Bitmap src) {
    int w = src.Width, h = src.Height, x0 = w, y0 = h, x1 = -1, y1 = -1;
    var px = Read(src);
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] <= 24) continue;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    return x1 < 0 ? new Rectangle(0, 0, w, h) : new Rectangle(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }
}
'@
$root = Split-Path $PSScriptRoot -Parent
$outDir = Join-Path $PSScriptRoot 'console-icons-extra'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$size = 256
# File -> output name (what scripts/console-icons-source.json names), and how to clear its backdrop: tol = how close a
# pixel must be to the backdrop's colour; loose = also take light grey next to it (only for drawings with a dark outline).
$pictures = [ordered]@{
  'Android.png'   = @{ name = 'Google Android'; tol = 6; loose = $false }
  'PS4.webp'      = @{ name = 'Sony PlayStation 4'; tol = 10; loose = $true }
  'PS5.png'       = @{ name = 'Sony PlayStation 5'; tol = 3; loose = $false }
  'PSVita.webp'   = @{ name = 'Sony PlayStation Vita'; tol = 6; loose = $false }
  'ScummVM.jpg'   = @{ name = 'ScummVM'; tol = 12; loose = $true }
  'Switch 2.webp' = @{ name = 'Nintendo Switch 2'; tol = 8; loose = $false }
}
foreach ($file in $pictures.Keys) {
  $p = $pictures[$file]
  $path = Join-Path $Source $file
  if (-not (Test-Path -LiteralPath $path)) { throw "missing picture: $path" }
  # Windows' imaging decoder reads WebP too; to 32-bit BGRA either way.
  $stream = [IO.File]::OpenRead($path)
  $frame = [System.Windows.Media.Imaging.BitmapDecoder]::Create($stream, 'PreservePixelFormat', 'OnLoad').Frames[0]
  $stream.Dispose()
  $bgra = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap $frame, ([System.Windows.Media.PixelFormats]::Bgra32), $null, 0
  $w = $bgra.PixelWidth; $h = $bgra.PixelHeight
  $bytes = New-Object byte[] ($w * $h * 4)
  $bgra.CopyPixels($bytes, $w * 4, 0)
  $img = [ConsoleIconExtra]::FromBgra($bytes, $w, $h)
  $img = [ConsoleIconExtra]::ClearBackground($img, [int]$p.tol, [bool]$p.loose)
  $box = [ConsoleIconExtra]::Bounds($img)
  # [double] 1.0: with a plain 1 PowerShell picks Math.Min(int, int) and rounds the scale to 0 or 1.
  $scale = [math]::Min([double]1.0, [math]::Min([double]$size / $box.Width, [double]$size / $box.Height))
  $ow = [int][math]::Round($box.Width * $scale); $oh = [int][math]::Round($box.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap $ow, $oh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
  $g.CompositingQuality = 'HighQuality'
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $ow, $oh), $box, [System.Drawing.GraphicsUnit]::Pixel)
  $bmp.Save((Join-Path $outDir "$($p.name).png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  "$file -> console-icons-extra\$($p.name).png ($ow x $oh)"
}
