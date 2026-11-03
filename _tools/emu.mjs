import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const ROOT = 'C:\\Users\\www34\\Desktop\\模拟器';
const AVD = 'A14_Play';
const PORT = 5554;
const ADB = ROOT + '\\android-sdk\\platform-tools\\adb.exe';
const EMU = ROOT + '\\android-sdk\\emulator\\emulator.exe';
const LOG = ROOT + '\\_logs\\em.log';

const env = {
  ...process.env,
  HOME: ROOT + '\\home',
  ANDROID_USER_HOME: ROOT + '\\home\\.android',
  ANDROID_AVD_HOME: ROOT + '\\avd',
  ANDROID_SDK_ROOT: ROOT + '\\android-sdk',
  ANDROID_HOME: ROOT + '\\android-sdk',
  ADB_VENDOR_KEYS: ROOT + '\\home\\.android',
};

function killAll() {
  for (const name of ['qemu-system-x86_64-headless', 'emulator', 'netsimd', 'adb']) {
    try { execFileSync('taskkill', ['/F', '/IM', name + '.exe'], { stdio: 'ignore' }); } catch {}
  }
}
function cleanAvd() {
  const avd = ROOT + '\\avd\\' + AVD + '.avd';
  const junk = ['hardware-qemu.ini.lock','multiinstance.lock','hardware-qemu.ini','emu-launch-params.txt','version_num.cache','initrd','data','userdata-qemu.img','bootcompleted.ini','tmpAdbCmds','read-snapshot.txt'];
  for (const f of junk) { try { fs.rmSync(avd + '\\' + f, { recursive: true, force: true }); } catch {} }
  for (const f of fs.readdirSync(avd)) if (f.endsWith('.qcow2')) { try { fs.rmSync(avd + '\\' + f, { force: true }); } catch {} }
  try { fs.rmSync(avd + '\\snapshots', { recursive: true, force: true }); } catch {}
}

const mode = process.argv[2] || 'boot';

if (mode === 'boot') {
  killAll();
  await new Promise(r => setTimeout(r, 3000));
  cleanAvd();
  try { fs.rmSync(LOG, { force: true }); } catch {}
  try { execFileSync(ADB, ['kill-server'], { stdio: 'ignore', env }); } catch {}
  execFileSync(ADB, ['start-server'], { stdio: 'ignore', env });
  const out = fs.openSync(LOG, 'w');
  const args = ['-avd', AVD, '-no-window', '-no-audio', '-no-snapshot', '-no-boot-anim', '-gpu', 'swiftshader_indirect', '-port', String(PORT), '-no-metrics', '-writable-system', ...process.argv.slice(3)];
  // 沙箱禁止 piped stdio，改用文件描述符
  const child = spawn(EMU, args, { env, stdio: ['ignore', out, out], detached: false, windowsHide: true });
  console.log('emulator pid', child.pid, 'args:', args.join(' '));
  child.on('exit', (c, s) => console.log('emulator exited', c, s));

  const t0 = Date.now();
  let ok = false;
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 3000));
    let devs = '';
    try { devs = execFileSync(ADB, ['devices'], { env, encoding: 'utf8' }); } catch (e) { devs = String(e); }
    const state = (devs.match(/emulator-5554\s+(\S+)/) || [])[1] || 'none';
    if (i % 3 === 0) console.log(`t=${((Date.now() - t0) / 1000).toFixed(0)}s state=${state}`);
    if (state === 'device') { ok = true; break; }
    if (child.exitCode !== null) { console.log('emulator died, exit', child.exitCode); break; }
  }
  console.log('ADB READY:', ok);
  if (ok) {
    try {
      const boot = execFileSync(ADB, ['-s', 'emulator-5554', 'shell', 'getprop sys.boot_completed; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.model'], { env, encoding: 'utf8' });
      console.log('--- boot props ---\n' + boot);
    } catch (e) { console.log('shell error', String(e)); }
  }
  // keep process alive? no - emulator is detached enough for a short-lived shell? it will be killed on exit, so run long
  process.exit(0);
}

if (mode === 'adb') {
  const r = execFileSync(ADB, process.argv.slice(3), { env, encoding: 'utf8' });
  console.log(r);
}
