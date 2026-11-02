#requires -Version 5.1
<#
  cortico-world-ocr 的识别桥:截屏 → 内存里缩放 → Windows.Media.Ocr → 文本块。
  必须用 Windows PowerShell 5.1(powershell.exe);pwsh 7 加载不了 WinRT 类型。

  输入:-ParamsB64 <base64(UTF-8 JSON)>
    { region?: {x,y,w,h}, scale: number, maxEdge: number, foregroundOnly: bool, language?: string }
  输出:stdout 上一段 base64(UTF-8 JSON),不落盘、不返回图片
    { ok: true, source, origin:{x,y}, size:{w,h}, image:{w,h}, fx, fy, language, angle,
      blocks: [{ text, x, y, w, h, line }] }     # 块坐标是识别图里的像素,换算由调用方做
    { ok: false, reason }
#>
param([Parameter(Mandatory = $true)][string]$ParamsB64)

$ErrorActionPreference = 'Stop'

function Write-Result($obj) {
  $json = ConvertTo-Json -InputObject $obj -Depth 6 -Compress
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
}

function Get-Reason($err) {
  $e = $err.Exception
  while ($null -ne $e.InnerException) { $e = $e.InnerException }
  return $e.Message
}

try {
  if ($PSVersionTable.PSEdition -eq 'Core') {
    throw '需要 Windows PowerShell 5.1(powershell.exe);pwsh 7 加载不了 Windows.Media.Ocr'
  }
  $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ParamsB64)) | ConvertFrom-Json

  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CorticoOcrNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
}
'@

  # 物理像素坐标:先声明 DPI 感知,再碰任何窗口或屏幕 API
  $dpiOk = $false
  try { $dpiOk = [CorticoOcrNative]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { $dpiOk = $false }
  if (-not $dpiOk) { [void][CorticoOcrNative]::SetProcessDPIAware() }

  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

  $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  function Wait-WinRt($op, [Type]$resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
    [void]$task.Wait(-1)
    return $task.Result
  }

  # ---- 截哪一块 ----
  $vx = [CorticoOcrNative]::GetSystemMetrics(76); $vy = [CorticoOcrNative]::GetSystemMetrics(77)
  $vw = [CorticoOcrNative]::GetSystemMetrics(78); $vh = [CorticoOcrNative]::GetSystemMetrics(79)

  $source = ''
  if ($null -ne $p.region) {
    $l = [int]$p.region.x; $t = [int]$p.region.y
    $r = $l + [int]$p.region.w; $b = $t + [int]$p.region.h
    $source = 'region'
  } else {
    $hwnd = [CorticoOcrNative]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { throw '拿不到前台窗口(可能在锁屏或安全桌面)' }
    $mi = New-Object CorticoOcrNative+MONITORINFO
    $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
    $mon = [CorticoOcrNative]::MonitorFromWindow($hwnd, 2)
    if (-not [CorticoOcrNative]::GetMonitorInfo($mon, [ref]$mi)) { throw '读不到显示器信息' }
    $l = $mi.rcMonitor.Left; $t = $mi.rcMonitor.Top; $r = $mi.rcMonitor.Right; $b = $mi.rcMonitor.Bottom
    $source = 'monitor'
    if ($p.foregroundOnly -and -not [CorticoOcrNative]::IsIconic($hwnd)) {
      $wr = New-Object CorticoOcrNative+RECT
      # DWMWA_EXTENDED_FRAME_BOUNDS = 9:不含阴影的真实边框
      $hr = [CorticoOcrNative]::DwmGetWindowAttribute($hwnd, 9, [ref]$wr, [Runtime.InteropServices.Marshal]::SizeOf($wr))
      if ($hr -ne 0) { [void][CorticoOcrNative]::GetWindowRect($hwnd, [ref]$wr) }
      $l = [Math]::Max($l, $wr.Left); $t = [Math]::Max($t, $wr.Top)
      $r = [Math]::Min($r, $wr.Right); $b = [Math]::Min($b, $wr.Bottom)
      $source = 'window'
    }
  }
  # 夹到虚拟屏幕范围内
  $l = [Math]::Max($l, $vx); $t = [Math]::Max($t, $vy)
  $r = [Math]::Min($r, $vx + $vw); $b = [Math]::Min($b, $vy + $vh)
  $w = $r - $l; $h = $b - $t
  if ($w -le 0 -or $h -le 0) { throw "截图区域为空:$l,$t ${w}x$h" }

  # ---- 截屏,只在内存里 ----
  $shot = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($shot)
  try {
    $g.CopyFromScreen($l, $t, 0, 0, (New-Object System.Drawing.Size $w, $h), [System.Drawing.CopyPixelOperation]::SourceCopy)
  } finally { $g.Dispose() }

  # ---- 缩放:长边不超过 maxEdge,再乘上调用方给的 scale ----
  $scale = [double]$p.scale
  $maxEdge = [double]$p.maxEdge
  $factor = [Math]::Min($scale, $maxEdge / [Math]::Max($w, $h))
  $img = $shot
  if ([Math]::Abs($factor - 1.0) -gt 0.001) {
    $tw = [Math]::Max(1, [int][Math]::Round($w * $factor))
    $th = [Math]::Max(1, [int][Math]::Round($h * $factor))
    $img = New-Object System.Drawing.Bitmap $tw, $th, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g2 = [System.Drawing.Graphics]::FromImage($img)
    try {
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g2.DrawImage($shot, 0, 0, $tw, $th)
    } finally { $g2.Dispose() }
    $shot.Dispose()
  }
  $iw = $img.Width; $ih = $img.Height

  # ---- 交给 WinRT:MemoryStream → IRandomAccessStream → SoftwareBitmap ----
  $ms = New-Object System.IO.MemoryStream
  try {
    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
  } finally { $img.Dispose() }
  $ms.Position = 0
  $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
  $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $soft = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  # ---- 识别 ----
  $engine = $null
  if ($p.language) {
    $lang = New-Object Windows.Globalization.Language ([string]$p.language)
    if (-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) {
      throw "系统没装 $($p.language) 的 OCR 语言包:设置 → 时间和语言 → 语言,添加该语言并勾选「光学字符识别」"
    }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  } else {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  }
  if ($null -eq $engine) { throw '没有可用的 OCR 语言:设置 → 时间和语言 → 语言,添加带「光学字符识别」的语言' }

  $res = Wait-WinRt ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
  try { $soft.Dispose(); $ras.Dispose() } catch { }
  $ms.Dispose()

  $blocks = New-Object System.Collections.Generic.List[object]
  $li = 0
  foreach ($line in $res.Lines) {
    foreach ($word in $line.Words) {
      $br = $word.BoundingRect
      $blocks.Add([pscustomobject]@{
        text = [string]$word.Text
        x = [double]$br.X; y = [double]$br.Y; w = [double]$br.Width; h = [double]$br.Height
        line = $li
      })
    }
    $li++
  }

  $angle = $null
  if ($null -ne $res.TextAngle) { $angle = [double]$res.TextAngle }
  Write-Result ([pscustomobject]@{
    ok = $true
    source = $source
    origin = [pscustomobject]@{ x = $l; y = $t }
    size = [pscustomobject]@{ w = $w; h = $h }
    image = [pscustomobject]@{ w = $iw; h = $ih }
    fx = [double]$iw / $w
    fy = [double]$ih / $h
    language = [string]$engine.RecognizerLanguage.LanguageTag
    angle = $angle
    blocks = $blocks.ToArray()
  })
} catch {
  Write-Result ([pscustomobject]@{ ok = $false; reason = (Get-Reason $_) })
}
