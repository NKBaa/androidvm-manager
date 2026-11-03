// 截取指定窗口画面（路径经环境变量传入，避免中文路径编码问题）
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pid = process.argv[2];
const outFile = process.argv[3];

const ps = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$p = Get-Process -Id ([int]$env:CAP_PID) -ErrorAction SilentlyContinue
if (-not $p) { Write-Output "NOTFOUND"; exit 1 }
$h = $p.MainWindowHandle
[Win32]::ShowWindow($h, 9) | Out-Null
[Win32]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 1200
$r = New-Object Win32+RECT
[Win32]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
Write-Output ("RECT " + $r.Left + "," + $r.Top + "," + $w + "," + $ht)
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[System.IO.File]::WriteAllBytes($env:CAP_OUT, $ms.ToArray())
Write-Output "SAVED"
`;
const scriptPath = path.join(__dirname, 'shot2.ps1');
fs.writeFileSync(scriptPath, ps, 'utf8');
const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
  encoding: 'utf8',
  env: { ...process.env, CAP_PID: pid, CAP_OUT: outFile },
});
console.log(out.trim());
console.log('exists:', fs.existsSync(outFile), fs.existsSync(outFile) ? fs.statSync(outFile).size + ' bytes' : '');
