# 一键打包 AndroidVM 安装包
#
# 用法:  pwsh -File _tools\build.ps1
# 产物:  dist\AndroidVM-Setup-<ver>.exe      (NSIS 安装程序)
#        dist\AndroidVM-Portable-<ver>.exe   (免安装便携版)
#        dist\win-unpacked\                  (解包目录，便于调试)
#
# 为什么需要这个脚本（都是实测踩过的坑）：
#   1) 本机 %TEMP% 对子进程不可写 —— electron-builder / NSIS 会报
#      "Access is denied" 或 "!tempfile: Unable to create temporary file!"，
#      所以把 TEMP/TMP 指到项目内的 _cache\tmp。
#   2) electron 下载缓存目录同样不可写，用 ELECTRON_CACHE 指到项目内。
#   3) 非管理员无法创建符号链接，winCodeSign 包解压失败 ——
#      因此 package.json 里设了 signAndEditExecutable:false，
#      改由 build/afterPack.js 调 rcedit 写图标与版本信息。
#   4) ELECTRON_RUN_AS_NODE=1 会让 electron 以纯 Node 模式跑，必须清掉。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $root 'app'
$cache = Join-Path $root '_cache'

New-Item -ItemType Directory -Force -Path (Join-Path $cache 'tmp'), (Join-Path $cache 'electron'), (Join-Path $cache 'builder') | Out-Null

$env:TEMP = Join-Path $cache 'tmp'
$env:TMP = $env:TEMP
$env:ELECTRON_CACHE = Join-Path $cache 'electron'
$env:ELECTRON_BUILDER_CACHE = Join-Path $cache 'builder'
$env:ELECTRON_RUN_AS_NODE = ''

# 依赖检查
if (-not (Test-Path (Join-Path $appDir 'node_modules\electron-builder'))) {
  Write-Host '未安装 electron-builder，正在安装…' -ForegroundColor Yellow
  Push-Location $appDir
  npm install --save-dev electron-builder@24.13.3 --no-audit --no-fund
  Pop-Location
}

# 图标（缺失时自动生成）
$ico = Join-Path $appDir 'build\icon.ico'
if (-not (Test-Path $ico)) {
  Write-Host '生成图标…' -ForegroundColor Yellow
  $py = Join-Path $env:LOCALAPPDATA '..\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
  if (-not (Test-Path $py)) { $py = 'python' }
  & $py (Join-Path $root '_tools\make-icon.py')
}

Write-Host ''
Write-Host '开始打包…' -ForegroundColor Cyan
Push-Location $appDir
try {
  npm run dist
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($code -ne 0) { throw "打包失败（exit $code）" }

Write-Host ''
Write-Host '打包完成，产物：' -ForegroundColor Green
Get-ChildItem (Join-Path $root 'dist') -File -Filter '*.exe' |
  Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } |
  Format-Table -AutoSize
