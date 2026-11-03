# GPU / 显示探针：以指定 -gpu 模式启动模拟器，截取窗口与 screencap，判定是否黑屏
param(
  [string]$GpuMode = "swiftshader_indirect",
  [string]$Tag = "probe",
  [int]$BootWaitSec = 110,
  [switch]$Headless
)

$ErrorActionPreference = "Continue"
$root = "C:\Users\www34\Desktop\Code\模拟器"
$env:ANDROID_HOME = "$root\android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_USER_HOME = "$root\home\.android"
$env:ANDROID_AVD_HOME = "$root\avd"
$env:ADB_VENDOR_KEYS = "$root\home\.android"
$env:TEMP = "$root\home\adbhome"
$env:TMP = $env:TEMP
$adb = "$root\android-sdk\platform-tools\adb.exe"
$emu = "$root\android-sdk\emulator\emulator.exe"
$logDir = "$root\_logs"
$outDir = "$logDir\gpu_$Tag"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 清理残留
& "$root\android-sdk\platform-tools\adb.exe" kill-server 2>$null | Out-Null
Get-Process -Name "qemu-system-x86_64*", "emulator*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$args = @("-avd","A14_Root","-gpu",$GpuMode,"-port","5554","-no-metrics","-no-boot-anim","-no-snapshot-save","-no-audio")
if ($Headless) { $args += "-no-window" }

Write-Host "== launching: emulator $($args -join ' ')"
$p = Start-Process -FilePath $emu -ArgumentList $args -PassThru -RedirectStandardOutput "$outDir\emu.out.log" -RedirectStandardError "$outDir\emu.err.log"
Write-Host "== pid=$($p.Id)"

# 等待 adb 上线
$t0 = Get-Date
$online = $false
while (((Get-Date) - $t0).TotalSeconds -lt $BootWaitSec) {
  $devs = & $adb devices 2>$null | Select-String "emulator-5554\s+device"
  if ($devs) { $online = $true; break }
  Start-Sleep -Seconds 3
}
$boot = "no"
if ($online) {
  for ($i = 0; $i -lt 40; $i++) {
    $b = (& $adb -s emulator-5554 shell getprop sys.boot_completed 2>$null) -join ""
    if ($b.Trim() -eq "1") { $boot = "yes"; break }
    Start-Sleep -Seconds 2
  }
}
Write-Host "== online=$online boot_completed=$boot elapsed=$([int]((Get-Date)-$t0).TotalSeconds)s"

if ($boot -eq "yes") {
  Start-Sleep -Seconds 8
  # 1) screencap
  & $adb -s emulator-5554 exec-out screencap -p > "$outDir\screencap.png" 2>$null
  # 2) Window capture (only if windowed)
  if (-not $Headless) {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $sig = @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
    if (-not ("W" -as [type])) { Add-Type -TypeDefinition $sig }
    $win = Get-Process | Where-Object { $_.MainWindowTitle -ne "" -and ($_.ProcessName -match 'qemu|emulator') } | Select-Object -First 1
    if ($win) {
      Write-Host "== window: '$($win.MainWindowTitle)' pid=$($win.Id) vis=$([W]::IsWindowVisible($win.MainWindowHandle))"
      [W]::SetForegroundWindow($win.MainWindowHandle) | Out-Null
      Start-Sleep -Seconds 1
      $r = New-Object W+RECT
      [W]::GetWindowRect($win.MainWindowHandle, [ref]$r) | Out-Null
      $w = $r.R - $r.L; $h = $r.B - $r.T
      Write-Host "== rect: $($r.L),$($r.T) ${w}x${h}"
      if ($w -gt 0 -and $h -gt 0) {
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
        $bmp.Save("$outDir\window.png", [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        Write-Host "== saved window.png"
      }
    } else {
      Write-Host "== WARN: no window found"
    }
  }
}

# 分析黑屏
function Analyze($path, $name) {
  if (-not (Test-Path $path)) { Write-Host "== $name MISSING"; return }
  $len = (Get-Item $path).Length
  if ($len -lt 100) { Write-Host "== $name EMPTY ($len bytes)"; return }
  Add-Type -AssemblyName System.Drawing
  try {
    $b = [System.Drawing.Bitmap]::FromFile($path)
    $sx = [Math]::Max(1, [int]($b.Width / 64)); $sy = [Math]::Max(1, [int]($b.Height / 64))
    $sum = 0.0; $n = 0; $uniq = @{}
    for ($y = 0; $y -lt $b.Height; $y += $sy) { for ($x = 0; $x -lt $b.Width; $x += $sx) {
      $c = $b.GetPixel($x, $y); $sum += ($c.R + $c.G + $c.B) / 3.0; $n++
      $uniq["$($c.R),$($c.G),$($c.B)"] = 1
    } }
    $avg = [Math]::Round($sum / $n, 2)
    Write-Host ("== {0}: {1}x{2} avgLuma={3} distinctColors={4} bytes={5}" -f $name, $b.Width, $b.Height, $avg, $uniq.Count, $len)
    $b.Dispose()
  } catch { Write-Host "== $name analyze failed: $_" }
}
Analyze "$outDir\screencap.png" "screencap"
if (-not $Headless) { Analyze "$outDir\window.png" "window" }

# 记录 GPU 相关日志
Select-String -Path "$outDir\emu.out.log","$outDir\emu.err.log" -Pattern 'gpu|GPU|Vulkan|vulkan|swiftshader|SwiftShader|angle|ANGLE|Error|error|fail|Fail|crash' -ErrorAction SilentlyContinue |
  Select-Object -First 40 | ForEach-Object { "LOG: $($_.Line)" }

Write-Host "== stopping"
& $adb -s emulator-5554 emu kill 2>$null | Out-Null
Start-Sleep -Seconds 4
Get-Process -Name "qemu-system-x86_64*", "emulator*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "== done"
