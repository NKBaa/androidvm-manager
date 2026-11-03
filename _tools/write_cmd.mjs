// 生成 GBK 编码的 emulator 启动批处理（避免中文路径在 cmd 下乱码）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = [
  '@echo off',
  `set ANDROID_HOME=${ROOT}\\android-sdk`,
  'set ANDROID_SDK_ROOT=%ANDROID_HOME%',
  `set ANDROID_USER_HOME=${ROOT}\\home\\.android`,
  `set ANDROID_AVD_HOME=${ROOT}\\avd`,
  `set ADB_VENDOR_KEYS=${ROOT}\\home\\.android`,
  `set TEMP=${ROOT}\\home\\adbhome`,
  'set TMP=%TEMP%',
  `cd /d "${ROOT}"`,
  `"%ANDROID_HOME%\\emulator\\emulator.exe" ${process.argv.slice(2).join(' ')} > "${ROOT}\\_logs\\em5.log" 2>&1`,
];

// chcp 936 环境下 GBK 显示中文目录名：用 iconv 手工映射（仅"模拟器"三字）
const GBK = { '模': [0xc4, 0xa3], '拟': [0xc4, 0xe2], '器': [0xc6, 0xf7] };
function toGBK(s) {
  const out = [];
  for (const ch of s) {
    if (GBK[ch]) out.push(...GBK[ch]);
    else for (const b of Buffer.from(ch, 'utf8')) out.push(b);
  }
  return Buffer.from(out);
}
const text = lines.join('\r\n') + '\r\n';
fs.writeFileSync(path.join(ROOT, '_tools', 'start_emu2.cmd'), toGBK(text));
console.log('written; sample:', lines[8]);
