// 独立进程：给指定实例补应用真机档案。
// 由 VmManager 在启动后以 detached 方式拉起，因此**不依赖 App 是否还开着**。
// 用法: node reapply-cli.js <serial> <port>
const adbmod = require('./adb');
const dp = require('./deviceprofile');

const serial = process.argv[2];
const port = Number(process.argv[3]) || 5554;

(async () => {
  if (serial) adbmod.setTarget(serial, port);
  try {
    const r = await dp.reapplyIfNeeded();
    console.log(JSON.stringify({ ok: !!(r && r.ok), already: !!(r && r.already), reboots: r && r.reboots, reason: r && r.reason }));
    process.exit(0);
  } catch (e) {
    console.error('reapply failed: ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
})();
