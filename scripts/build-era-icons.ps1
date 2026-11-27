# Builds the era pictures of Filters > Release (src/renderer/src/assets/era-icons/<era id>.png) from the user's
# "Gaming Epoch Icons" set: picture 1 is the oldest era ("Before 1990"), picture 8 the newest ("2025-Present"). Each
# picture is scaled to 96 x 96 (high quality, transparency kept).
#   powershell -ExecutionPolicy Bypass -File scripts/build-era-icons.ps1 [-Source "<folder>"]
param([string]$Source = "$env:USERPROFILE\Downloads\Gaming Epoch Icons")
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$size = 96
# Picture number -> lib/releaseEras.ts RELEASE_ERAS id, oldest first.
$eras = [ordered]@{
  '1' = 'y-before-1990'
  '2' = 'y-1990-2000'
  '3' = 'y-2000-2005'
  '4' = 'y-2005-2010'
  '5' = 'y-2010-2015'
  '6' = 'y-2015-2020'
  '7' = 'y-2020-2025'
  '8' = 'y-2025'
}
$outDir = Join-Path $root 'src\renderer\src\assets\era-icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Get-ChildItem $outDir -Filter *.png | Remove-Item -Force
foreach ($n in $eras.Keys) {
  $file = Get-ChildItem -LiteralPath $Source -Filter "$n - *.png" | Select-Object -First 1
  if (-not $file) { throw "missing picture $n in $Source" }
  $img = [System.Drawing.Image]::FromFile($file.FullName)
  $scale = [math]::Min($size / $img.Width, $size / $img.Height)
  $w = [int][math]::Round($img.Width * $scale); $h = [int][math]::Round($img.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
  $g.CompositingQuality = 'HighQuality'
  $g.DrawImage($img, [int](($size - $w) / 2), [int](($size - $h) / 2), $w, $h)
  $bmp.Save((Join-Path $outDir "$($eras[$n]).png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  "$($file.Name) -> $($eras[$n]).png"
}
