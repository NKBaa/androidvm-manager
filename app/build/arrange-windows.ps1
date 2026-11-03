# 把指定进程的顶层窗口在桌面上排列好
#
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File arrange-windows.ps1 -Pids "123,456" -Layout grid
#   布局: grid（平铺） / h（横向） / v（纵向） / cascade（层叠）
# 输出: 实际排列的窗口数量（单个数字），失败输出 0
#
# 只处理「可见、有标题、尺寸大于 200x200」的顶层窗口，
# 避免误动模拟器进程里的隐藏辅助窗口。

param(
  [Parameter(Mandatory = $true)][string]$Pids,
  [ValidateSet('grid', 'h', 'v', 'cascade')][string]$Layout = 'grid'
)

$ErrorActionPreference = 'Stop'

# 必须先声明 DPI 感知，否则在缩放显示器上
# [Screen]::WorkingArea 返回的是逻辑像素（如 1707），
# 而 SetWindowPos 用的是物理像素（如 2560），窗口只会填满 2/3 屏幕。
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class DpiHelper {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(int value);
}
'@
try { [void][DpiHelper]::SetProcessDpiAwarenessContext(-4) } catch {}

$pidList = @()
foreach ($p in ($Pids -split ',')) {
  $t = $p.Trim()
  if ($t -match '^\d+$') { $pidList += [int]$t }
}
if ($pidList.Count -eq 0) { Write-Output '0'; exit 0 }

Add-Type -AssemblyName System.Windows.Forms

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinArr {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$handles = New-Object System.Collections.ArrayList

$callback = [WinArr+EnumProc] {
  param([IntPtr]$hWnd, [IntPtr]$lParam)

  $ownerPid = [uint32]0
  [void][WinArr]::GetWindowThreadProcessId($hWnd, [ref]$ownerPid)

  if ($script:pidList -contains [int]$ownerPid) {
    if ([WinArr]::IsWindowVisible($hWnd) -and [WinArr]::GetWindowTextLength($hWnd) -gt 0) {
      $rect = New-Object WinArr+RECT
      [void][WinArr]::GetWindowRect($hWnd, [ref]$rect)
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      if ($w -gt 200 -and $h -gt 200) { [void]$script:handles.Add($hWnd) }
    }
  }
  return $true
}

[void][WinArr]::EnumWindows($callback, [IntPtr]::Zero)

$n = $handles.Count
if ($n -eq 0) { Write-Output '0'; exit 0 }

$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$SW_RESTORE = 9
$SWP_NOZORDER = 0x0004
$SWP_SHOWWINDOW = 0x0040
$flags = $SWP_NOZORDER -bor $SWP_SHOWWINDOW

function Place([IntPtr]$h, [int]$x, [int]$y, [int]$w, [int]$hgt) {
  [void][WinArr]::ShowWindow($h, $SW_RESTORE)
  [void][WinArr]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $w, $hgt, $flags)
}

if ($Layout -eq 'cascade') {
  $w = [int]($wa.Width * 0.55)
  $hgt = [int]($wa.Height * 0.65)
  $step = 36
  for ($i = 0; $i -lt $n; $i++) {
    Place $handles[$i] ($wa.X + 24 + $i * $step) ($wa.Y + 24 + $i * $step) $w $hgt
  }
} else {
  switch ($Layout) {
    'h' { $cols = $n; $rows = 1 }
    'v' { $cols = 1; $rows = $n }
    default {
      $cols = [int][Math]::Ceiling([Math]::Sqrt($n))
      $rows = [int][Math]::Ceiling($n / $cols)
    }
  }
  $gap = 6
  $cellW = [int](($wa.Width - $gap * ($cols + 1)) / $cols)
  $cellH = [int](($wa.Height - $gap * ($rows + 1)) / $rows)

  for ($i = 0; $i -lt $n; $i++) {
    $r = [int][Math]::Floor($i / $cols)
    $c = $i % $cols
    $x = $wa.X + $gap + $c * ($cellW + $gap)
    $y = $wa.Y + $gap + $r * ($cellH + $gap)
    Place $handles[$i] $x $y $cellW $cellH
  }
}

Write-Output ([string]$n)
