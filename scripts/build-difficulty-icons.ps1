# Builds the difficulty pictures of Filters > Difficulty (src/renderer/src/assets/difficulty-icons/<difficulty>.png)
# from the user's "Difficulty Icons" set: picture 1 is the easiest choice ("Story"), picture 5 the hardest
# ("Impossible"). Each picture is scaled to 96 x 96 (high quality, transparency kept).
#   powershell -ExecutionPolicy Bypass -File scripts/build-difficulty-icons.ps1 [-Source "<folder>"]
param([string]$Source = "$env:USERPROFILE\Downloads\Difficulty Icons")
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$size = 96
# Picture number -> shared/difficulty.ts DIFFICULTIES id, easiest first.
$levels = [ordered]@{
  '1' = 'story'
  '2' = 'easy'
  '3' = 'medium'
  '4' = 'hard'
  '5' = 'impossible'
}
$outDir = Join-Path $root 'src\renderer\src\assets\difficulty-icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Get-ChildItem $outDir -Filter *.png | Remove-Item -Force
foreach ($n in $levels.Keys) {
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
  $bmp.Save((Join-Path $outDir "$($levels[$n]).png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  "$($file.Name) -> $($levels[$n]).png"
}
