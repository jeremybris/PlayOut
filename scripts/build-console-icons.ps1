# Builds the console icons of Filters > Platform (src/renderer/src/assets/console-icons) from the user's "HD Video
# Games" icon set: scripts/console-icons-source.json maps an emulation system id to the picture chosen for it (without
# ".png"); each picture is scaled to 96 x 96 (high quality, transparency kept) and saved under a slug of its name, and
# src/renderer/src/lib/console-icons.json maps every system id to its slug (regional twins share one picture).
#   powershell -ExecutionPolicy Bypass -File scripts/build-console-icons.ps1 [-Source "<folder>"]
param([string]$Source = "$env:USERPROFILE\Desktop\HD Video Games")
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$size = 96
$map = Get-Content (Join-Path $PSScriptRoot 'console-icons-source.json') -Raw | ConvertFrom-Json
$outDir = Join-Path $root 'src\renderer\src\assets\console-icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Get-Slug([string]$name) {
  (($name.ToLowerInvariant() -replace "[^a-z0-9]+", '-') -replace '^-+|-+$', '')
}

# The pictures built last time, copied aside: a picture whose original is not at hand (the HD Video Games folder moved)
# is rebuilt from its built copy, so a rebuild never loses a console.
$built = Join-Path $env:TEMP 'playout-console-icons-built'
Remove-Item -Recurse -Force -LiteralPath $built -ErrorAction SilentlyContinue
Copy-Item -Recurse -LiteralPath $outDir -Destination $built

# Where each picture comes from: the HD Video Games set, else scripts/console-icons-extra (pictures from outside that
# set, made by scripts/prepare-console-icon-extras.ps1), else last time's built copy. All are found before anything
# is replaced.
function Find-Picture([string]$picture) {
  foreach ($f in @((Join-Path $Source "$picture.png"),
                   (Join-Path (Join-Path $PSScriptRoot 'console-icons-extra') "$picture.png"),
                   (Join-Path $built "$(Get-Slug $picture).png"))) {
    if (Test-Path -LiteralPath $f) { return $f }
  }
  return $null
}
$sources = @{}
foreach ($p in $map.PSObject.Properties) {
  $picture = [string]$p.Value
  if ($sources.ContainsKey($picture)) { continue }
  $file = Find-Picture $picture
  if (-not $file) { throw "missing picture: $picture.png" }
  $sources[$picture] = $file
}
Get-ChildItem $outDir -Filter *.png | Remove-Item -Force

$bySystem = [ordered]@{}
$done = @{}
foreach ($p in $map.PSObject.Properties) {
  $picture = [string]$p.Value
  $slug = Get-Slug $picture
  $bySystem[$p.Name] = $slug
  if ($done.ContainsKey($slug)) { continue }
  $img = [System.Drawing.Image]::FromFile($sources[$picture])
  # Fit inside the square, keeping the aspect ratio, centred on transparency.
  $scale = [math]::Min($size / $img.Width, $size / $img.Height)
  $w = [int][math]::Round($img.Width * $scale); $h = [int][math]::Round($img.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
  $g.CompositingQuality = 'HighQuality'
  $g.DrawImage($img, [int](($size - $w) / 2), [int](($size - $h) / 2), $w, $h)
  $bmp.Save((Join-Path $outDir "$slug.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  $done[$slug] = $true
}
$json = ($bySystem | ConvertTo-Json) -replace "`r`n", "`n"
[IO.File]::WriteAllText((Join-Path $root 'src\renderer\src\lib\console-icons.json'), $json + "`n", (New-Object Text.UTF8Encoding $false))
"$($bySystem.Count) systems, $($done.Count) pictures -> $outDir"
