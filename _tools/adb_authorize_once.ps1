# 一次性 adb 授权：首次启动 Play 镜像时自动点击「允许 USB 调试」，授权将持久化到 userdata
param(
  [int]$TimeoutSec = 240
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

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# --- 最小化依赖的 UI 自动化：找窗口 -> 枚举子控件 -> 点击「Allow/允许」 ---
$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class W {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static List<IntPtr> AllWindows() {
    var list = new List<IntPtr>();
    EnumWindows((h, p) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static List<IntPtr> Children(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, (h, p) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Text(IntPtr h) {
    var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString();
  }
  public static string Class(IntPtr h) {
    var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString();
  }
}
'@
if (-not ("W" -as [type])) { Add-Type -TypeDefinition $sig }

function Click-At([int]$x, [int]$y) {
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
  Start-Sleep -Milliseconds 120
  Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);' -Name M -Namespace WM -ErrorAction SilentlyContinue
  [WM.M]::mouse_event(0x0002, 0, 0, 0, 0)   # left down
  Start-Sleep -Milliseconds 80
  [WM.M]::mouse_event(0x0004, 0, 0, 0, 0)   # left up
}

Write-Host "== 启动 Play 镜像（可见窗口，用于一次性授权）"
$proc = Start-Process -FilePath $emu `
  -ArgumentList @("-avd","A14_Root","-gpu","host","-port","5554","-no-metrics","-no-boot-anim","-no-snapshot-save","-no-audio") `
  -PassThru -RedirectStandardOutput "$root\_logs\auth.out.log" -RedirectStandardError "$root\_logs\auth.err.log"
Write-Host "pid=$($proc.Id)"

$t0 = Get-Date
$authorized = $false
$attempts = 0

while (((Get-Date) - $t0).TotalSeconds -lt $TimeoutSec) {
  Start-Sleep -Seconds 4
  $devs = (& $adb devices 2>$null) -join "`n"
  if ($devs -match 'emulator-5554\s+device') { $authorized = $true; break }
  if ($devs -notmatch 'emulator-5554\s+unauthorized') { continue }

  $attempts++
  # 找模拟器主窗口并置前
  $target = $null
  foreach ($h in [W]::AllWindows()) {
    if (-not [W]::IsWindowVisible($h)) { continue }
    $pid2 = 0; [W]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    if ($pid2 -eq $proc.Id) { $t = [W]::Text($h); if ($t -match 'Android|Emulator|A14') { $target = $h; break } }
  }
  if (-not $target) { continue }

  [W]::ShowWindow($target, 9) | Out-Null      # SW_RESTORE
  [W]::SetForegroundWindow($target) | Out-Null
  Start-Sleep -Milliseconds 700

  # 1) 尝试直接找到「允许/Allow」按钮控件
  $clicked = $false
  foreach ($c in [W]::Children($target)) {
    $txt = [W]::Text($c)
    if ($txt -match '^(Allow|允许|允许USB调试|Allow USB debugging|OK|确定)$') {
      $r = New-Object W+RECT
      [W]::GetWindowRect($c, [ref]$r) | Out-Null
      $cx = [int](($r.L + $r.R) / 2); $cy = [int](($r.T + $r.B) / 2)
      Write-Host "== 点击控件 '$txt' @ ($cx,$cy)"
      Click-At $cx $cy
      $clicked = $true
      break
    }
  }

  # 2) 控件找不到（游戏引擎渲染无子控件）：按窗口坐标点击「Allow」常见位置
  if (-not $clicked) {
    $r = New-Object W+RECT
    [W]::GetWindowRect($target, [ref]$r) | Out-Null
    $w = $r.R - $r.L; $h2 = $r.B - $r.T
    if ($w -gt 100 -and $h2 -gt 100) {
      # 对话框按钮通常位于底部偏右：「Allow」在右侧
      $cx = $r.L + [int]($w * 0.72)
      $cy = $r.T + [int]($h2 * 0.62)
      Write-Host "== 坐标点击 Allow 猜测位置 ($cx,$cy) [窗口 ${w}x${h2}] 第 $attempts 次"
      Click-At $cx $cy
    }
  }
  Start-Sleep -Seconds 3
}

if ($authorized) {
  Write-Host "== 授权成功：adb 已连上设备"
  # 验证并确认授权已持久化
  & $adb -s emulator-5554 shell getprop sys.boot_completed
} else {
  Write-Host "== 未在 $TimeoutSec 秒内完成授权"
}

Write-Host "== 最终状态"
& $adb devices
