# 界面预览：用无头 Chrome 渲染 renderer 并截图（不需要启动 Electron GUI）
#
# 用法:  pwsh -File _tools\ui-preview.ps1
# 产物:  _logs\ui_<tab>.png
#
# 原理：把 index.html 复制成 _preview.html，注入 _mock.js（提供 window.api 假数据）
#       和 _preview.js（按 ?tab= 切页），再用 Chrome --headless 截图。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$renderer = Join-Path $root 'app\renderer'
$logs = Join-Path $root '_logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) { throw '找不到 Chrome / Edge，无法生成预览截图' }

# 生成 _preview.html
$html = Get-Content (Join-Path $renderer 'index.html') -Raw
$html = $html -replace "script-src 'self'", "script-src 'self' 'unsafe-inline'"
$html = $html -replace "img-src 'self' data:", "img-src 'self' data: file:"
$html = $html -replace '<script src="renderer.js"></script>',
  '<script src="_mock.js"></script><script src="renderer.js"></script><script src="_preview.js"></script>'
$previewPath = Join-Path $renderer '_preview.html'
[System.IO.File]::WriteAllText($previewPath, $html, (New-Object System.Text.UTF8Encoding($false)))

# file:// URL（中文路径需要转义）
$uri = ([System.Uri]$previewPath).AbsoluteUri
$tabs = @('device', 'network', 'wireless', 'proxy', 'phone', 'hardware', 'shell')

foreach ($t in $tabs) {
  $out = Join-Path $logs "ui_$t.png"
  if (Test-Path $out) { Remove-Item $out -Force }
  & $chrome --headless=new --disable-gpu --hide-scrollbars `
    --window-size=1440,940 --virtual-time-budget=3500 `
    --screenshot="$out" "$uri`?tab=$t" 2>$null | Out-Null
  if (Test-Path $out) {
    Write-Host ("  {0,-12} {1,7:N0} B" -f "ui_$t.png", (Get-Item $out).Length)
  } else {
    Write-Host "  ui_$t.png  生成失败" -ForegroundColor Red
  }
}

# 启动器 / 卡片菜单 / 设备设置弹窗 / SDK 提示条
$extra = @(
  @{ n = 'ui_launcher';    q = 'view=launcher' },
  @{ n = 'ui_ctxmenu';     q = 'view=launcher&ctx=1' },
  @{ n = 'ui_devsettings'; q = 'view=launcher&dlg=perf' },
  @{ n = 'ui_sdk_banner';  q = 'tab=device&sdkready=0' },
  @{ n = 'ui_mini_input';  q = 'view=launcher&mini=input' },
  @{ n = 'ui_mini_backup'; q = 'view=launcher&mini=backup' },
  @{ n = 'ui_mini_batch';  q = 'view=launcher&mini=batch' }
)
foreach ($e in $extra) {
  $out = Join-Path $logs "$($e.n).png"
  if (Test-Path $out) { Remove-Item $out -Force }
  & $chrome --headless=new --disable-gpu --hide-scrollbars `
    --window-size=1440,940 --virtual-time-budget=5000 `
    --screenshot="$out" "$uri`?$($e.q)" 2>$null | Out-Null
  if (Test-Path $out) {
    Write-Host ("  {0,-16} {1,7:N0} B" -f "$($e.n).png", (Get-Item $out).Length)
  } else {
    Write-Host "  $($e.n).png  生成失败" -ForegroundColor Red
  }
}
Write-Host "预览截图已保存到 _logs\"
