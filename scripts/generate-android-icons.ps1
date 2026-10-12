$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskSource = Join-Path $taskRoot 'icons\icon-pro-512.png'
$taskResources = Join-Path $taskRoot 'android\app\src\main\res'
if (!(Test-Path -LiteralPath $taskResources)) { throw 'Android project must be created first.' }
$taskImage = [System.Drawing.Image]::FromFile($taskSource)
function Write-LauncherImage([string]$taskOutput, [int]$taskSize, [double]$taskFraction, [bool]$taskTransparent) {
    $taskBitmap = [System.Drawing.Bitmap]::new($taskSize, $taskSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $taskGraphics = [System.Drawing.Graphics]::FromImage($taskBitmap)
    try {
        $taskGraphics.Clear($(if ($taskTransparent) { [System.Drawing.Color]::Transparent } else { [System.Drawing.Color]::White }))
        $taskGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $taskGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $taskMax = $taskSize * $taskFraction
        $taskScale = [Math]::Min($taskMax / $taskImage.Width, $taskMax / $taskImage.Height)
        $taskWidth = [single]($taskImage.Width * $taskScale)
        $taskHeight = [single]($taskImage.Height * $taskScale)
        $taskRect = [System.Drawing.RectangleF]::new([single](($taskSize - $taskWidth) / 2), [single](($taskSize - $taskHeight) / 2), $taskWidth, $taskHeight)
        $taskGraphics.DrawImage($taskImage, $taskRect)
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
        Write-LauncherImage (Join-Path $taskDirectory 'ic_launcher.png') $taskDensity.Icon 0.92 $false
        Write-LauncherImage (Join-Path $taskDirectory 'ic_launcher_round.png') $taskDensity.Icon 0.92 $false
        # Adaptive foreground: fit the complete logo within the central 66dp safe region.
        Write-LauncherImage (Join-Path $taskDirectory 'ic_launcher_foreground.png') $taskDensity.Foreground (66.0 / 108.0) $true
    }
} finally { $taskImage.Dispose() }
Write-Output 'Generated 15 Android launcher PNGs from the existing full logo; aspect ratio preserved.'
