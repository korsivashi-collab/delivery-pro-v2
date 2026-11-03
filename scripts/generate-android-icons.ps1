$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskSource = Join-Path $taskRoot 'icons\icon-pro.svg'
$taskResources = Join-Path $taskRoot 'android\app\src\main\res'
if (!(Test-Path -LiteralPath $taskResources)) { throw 'Android project must be created first.' }
# Render the brand vector without its rounded tile. Do not erase colors from the logo.
$taskRenderer = @'
const fs = require('node:fs');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
(async () => {
  const svg = fs.readFileSync(process.argv[2], 'utf8');
  const tile = /<path id="App___blue_tile_with_internal_label"[^>]*\/>/g;
  if ([...svg.matchAll(tile)].length !== 1) throw new Error('Expected one brand background tile');
  const image = await loadImage(Buffer.from(svg.replace(tile, '')));
  const canvas = createCanvas(1024, 1024);
  canvas.getContext('2d').drawImage(image, 0, 0);
  process.stdout.write(canvas.toBuffer('image/png').toString('base64'));
})().catch(error => {console.error(error.message); process.exitCode=1;});
'@
Push-Location $taskRoot
try { $taskPng = $taskRenderer | & node - $taskSource; if ($LASTEXITCODE -ne 0) { throw 'Brand vector rendering failed.' } }
finally { Pop-Location }
$taskStream = [System.IO.MemoryStream]::new([Convert]::FromBase64String($taskPng))
$taskImage = [System.Drawing.Bitmap]::new($taskStream)
$taskBrandBlue = [System.Drawing.Color]::FromArgb(18, 89, 232)
$taskLeft = $taskImage.Width; $taskTop = $taskImage.Height; $taskRight = -1; $taskBottom = -1
for ($taskY = 0; $taskY -lt $taskImage.Height; $taskY += 2) {
    for ($taskX = 0; $taskX -lt $taskImage.Width; $taskX += 2) {
        $taskPixel = $taskImage.GetPixel($taskX, $taskY)
        if ($taskPixel.A -gt 32) {
            $taskLeft = [Math]::Min($taskLeft, $taskX); $taskTop = [Math]::Min($taskTop, $taskY)
            $taskRight = [Math]::Max($taskRight, $taskX); $taskBottom = [Math]::Max($taskBottom, $taskY)
        }
    }
}
if ($taskRight -lt 0) { $taskImage.Dispose(); throw 'The icon source has no visible logo.' }
$taskMargin = [int][Math]::Ceiling([Math]::Max($taskRight - $taskLeft, $taskBottom - $taskTop) * 0.02)
$taskLeft = [Math]::Max(0, $taskLeft - $taskMargin); $taskTop = [Math]::Max(0, $taskTop - $taskMargin)
$taskRight = [Math]::Min($taskImage.Width - 1, $taskRight + $taskMargin + 2)
$taskBottom = [Math]::Min($taskImage.Height - 1, $taskBottom + $taskMargin + 2)
$taskSourceRect = [System.Drawing.RectangleF]::new($taskLeft, $taskTop, $taskRight - $taskLeft + 1, $taskBottom - $taskTop + 1)
function Write-LauncherImage([string]$taskOutput, [int]$taskSize, [double]$taskFraction, [bool]$taskTransparent) {
    $taskBitmap = [System.Drawing.Bitmap]::new($taskSize, $taskSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $taskGraphics = [System.Drawing.Graphics]::FromImage($taskBitmap)
    try {
        $taskGraphics.Clear($(if ($taskTransparent) { [System.Drawing.Color]::Transparent } else { $taskBrandBlue }))
        $taskGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $taskGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $taskMax = $taskSize * $taskFraction
        $taskScale = [Math]::Min($taskMax / $taskSourceRect.Width, $taskMax / $taskSourceRect.Height)
        $taskWidth = [single]($taskSourceRect.Width * $taskScale)
        $taskHeight = [single]($taskSourceRect.Height * $taskScale)
        $taskRect = [System.Drawing.RectangleF]::new([single](($taskSize - $taskWidth) / 2), [single](($taskSize - $taskHeight) / 2), $taskWidth, $taskHeight)
        $taskGraphics.DrawImage($taskImage, $taskRect, $taskSourceRect, [System.Drawing.GraphicsUnit]::Pixel)
        $taskBitmap.Save($taskOutput, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $taskGraphics.Dispose(); $taskBitmap.Dispose() }
}
try {
    foreach ($taskDensity in @(
        @{Name='mdpi'; Icon=48; Foreground=108},
        @{Name='hdpi'; Icon=72; Foreground=162},
        @{Name='xhdpi'; Icon=96; Foreground=216},
        @{Name='xxhdpi'; Icon=144; Foreground=324},
        @{Name='xxxhdpi'; Icon=192; Foreground=432}
    )) {
        $taskDirectory = Join-Path $taskResources ('mipmap-' + $taskDensity.Name)
        New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
        Write-LauncherImage (Join-Path $taskDirectory 'ic_launcher.png') $taskDensity.Icon 0.82 $false
        Write-LauncherImage (Join-Path $taskDirectory 'ic_launcher_round.png') $taskDensity.Icon 0.82 $false
        # Adaptive foreground: fit the complete logo within the central 66dp safe region.
        Write-LauncherImage (Join-Path $taskDirectory 'ic_launcher_foreground.png') $taskDensity.Foreground (66.0 / 108.0) $true
    }
} finally { $taskImage.Dispose(); $taskStream.Dispose() }
Write-Output 'Generated 15 Android launcher PNGs; brand-blue background and separate transparent artwork.'
