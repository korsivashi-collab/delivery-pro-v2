$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskSource = Join-Path $taskRoot 'icons\icon-pro-512.png'
$taskResources = Join-Path $taskRoot 'android\app\src\main\res'
if (!(Test-Path -LiteralPath $taskResources)) { throw 'Android project must be created first.' }
$taskImage = [System.Drawing.Bitmap]::new($taskSource)
# 원본 로고의 넓은 흰 여백만 제외합니다. 심벌과 한글/PRO 글자는 모두 유지합니다.
$taskLeft = $taskImage.Width; $taskTop = $taskImage.Height; $taskRight = -1; $taskBottom = -1
for ($taskY = 0; $taskY -lt $taskImage.Height; $taskY += 2) {
    for ($taskX = 0; $taskX -lt $taskImage.Width; $taskX += 2) {
        $taskPixel = $taskImage.GetPixel($taskX, $taskY)
        if ($taskPixel.A -gt 32 -and [Math]::Min($taskPixel.R, [Math]::Min($taskPixel.G, $taskPixel.B)) -lt 210) {
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
        $taskGraphics.Clear($(if ($taskTransparent) { [System.Drawing.Color]::Transparent } else { [System.Drawing.Color]::White }))
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
        Write-LauncherImage (Join-Path $taskDirectory 'ic_launcher.png') $taskDensity.Icon 0.92 $false
        Write-LauncherImage (Join-Path $taskDirectory 'ic_launcher_round.png') $taskDensity.Icon 0.92 $false
        # Adaptive foreground: fit the complete logo within the central 66dp safe region.
        Write-LauncherImage (Join-Path $taskDirectory 'ic_launcher_foreground.png') $taskDensity.Foreground (66.0 / 108.0) $true
    }
} finally { $taskImage.Dispose() }
Write-Output 'Generated 15 Android launcher PNGs; outer white margins trimmed, full logo and aspect ratio preserved.'
