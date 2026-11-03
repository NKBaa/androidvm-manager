// 完整功能验证：停止 -> 窗口模式启动 -> 全功能 -> 输出报告
const fs = require('node:fs');
const path = require('node:path');
const { VmManager } = require('./src/vm');
const adbmod = require('./src/adb');
const net = require('./src/network');
const prox = require('./src/proxy');
const phone = require('./src/phone');
const dev = require('./src/device');
const camera = require('./src/camera');
const instances = require('./src/instances');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function runE2E() {
  const vm = new VmManager();
  let failed = 0;
  let deviceExpected = false; // 启动虚拟机之后才认为「设备应该在线」
  let healthCheck = false; // 启动完成（waitReady）之后才做服务健康检查
  const step = async (name, fn, verify) => {
    process.stdout.write(`[${String(results.length + 1).padStart(2, '0')}] ${name} ... `);
    try {
      // 只有「设备本该在线」且「已完成启动」之后才做健康检查，
      // 否则开机早期服务还没注册完会被误判成崩溃
      if (deviceExpected) {
        for (let i = 0; i < 20; i++) {
          const on = await adbmod.isOnline(adbmod.SERIAL).catch(() => false);
          if (on) break;
          await sleep(1000);
        }
      }
      if (healthCheck) {
        const svc = await adbmod.shell('service check window').catch(() => '');
        if (!String(svc).includes('found')) {
          results.push({ name, ok: false, detail: '系统服务无响应（模拟器 system_server 崩溃），未执行' });
          failed++;
          console.log('✗ 系统服务无响应，跳过');
          return null;
        }
      }
      const r = await fn();
      const ok = verify ? await verify(r) : true;
      results.push({ name, ok, detail: ok ? '' : '校验未通过' });
      if (!ok) failed++;
      console.log(ok ? '✓' : '✗');
      return r;
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
      failed++;
      console.log('✗ ' + e.message);
      return null;
    }
  };

  await step('停止虚拟机', () => vm.stop(), (r) => r && r.stopped);
  await sleep(3000);

  const startRes = await step('以窗口模式启动虚拟机', () => vm.start({ window: 'visible' }), (r) => r && r.ok);
  if (startRes) console.log('    参数:', (startRes.args || []).join(' '));
  deviceExpected = !!startRes;

  await step('等待系统启动并完成初始化(root/网络/号码)', async () => {
    const ok = await vm.waitReady(300000);
    return ok && (await adbmod.shell('getprop sys.boot_completed')) === '1';
  }, (r) => r === true);
  healthCheck = true; // 启动完成，后续步骤可以安全地做服务健康检查

  await step('读取系统版本', () => dev.getDeviceInfo(), (r) => r.release.trim() === '14' && r.sdk.trim() === '34');
  await step('谷歌服务(GMS)', () => adbmod.shell("pm list packages | grep com.google.android.gms"), (r) => r.includes('com.google.android.gms'));
  await step('Play 商店(vending)', () => adbmod.shell("pm list packages | grep com.android.vending"), (r) => r.includes('com.android.vending'));
  await step('Root 权限', () => dev.getRootStatus(), (r) => r.root === true && r.uid === '0');
  await step('网络限速 2G', () => net.setNetwork({ profile: 'gsm', radioType: 'GSM' }), (r) => !!r.speed);
  await step('2G 生效校验', () => net.getNetworkStatus(), (r) => /download speed:\s+14400/.test(r.console || ''));
  await step('恢复 WiFi 带宽', () => net.setNetwork({ profile: 'wifi', radioType: 'LTE' }), (r) => !!r.speed);
  // 说明：本机 netsimd 起不来（os error 5），Android 不会把 eth0 认成默认网络，
  // 主路由表没有 default 项，所以 DNS 解析必然失败。这一项失败是环境问题，不是代码问题。
  await step('DNS 连通性', () => net.testConnectivity(), (r) => /PING|\(/.test(r.dns || ''));
  await step('HTTP 代理写入', () => prox.setProxy({ enabled: true, type: 'http', host: '127.0.0.1', port: 8888, system: true }), (r) => r.applied.host === '10.0.2.2');
  await step('代理生效校验', () => prox.getProxyStatus(), (r) => String(r.proxySetting).includes('10.0.2.2:8888'));
  await step('SOCKS5 代理', () => prox.setProxy({ enabled: true, type: 'socks5', host: '127.0.0.1', port: 1080 }), (r) => !!r.note);
  await step('清除代理', () => prox.setProxy({ enabled: false }), (r) => r.cleared === true);
  await step('设置电话号码', () => phone.setPhoneNumber({ number: '+8613800138000', operator: '中国移动' }), (r) => r.ok);
  await step('号码生效校验', () => phone.getPhoneNumber(), (r) => String(r.number).includes('13800138000'));
  await step('注入中文短信', () => phone.receiveSms('+8613800138000', '【验证码】123456，5分钟内有效'), (r) => r.ok);
  await step('短信落库校验', () => phone.listSms(5), (r) => r.some((m) => String(m.body).includes('123456')));
  await step('信号强度设置', () => phone.signal(2), (r) => r.ok && r.level === 2);
  // 先恢复满格再测来电：弱信号下通话注册不上，会导致来电校验假失败
  await step('恢复满格信号', () => phone.signal(4), (r) => r.ok);
  await step('模拟来电', () => phone.call('call', '+8613800138000'), (r) => r.ok);
  // 通话状态有延迟，轮询几次；不能用 grep -m1（多卡时首行可能是别的 slot 的 0）
  await step(
    '来电状态校验',
    async () => {
      for (let i = 0; i < 8; i++) {
        await sleep(1500);
        const out = await adbmod.shell('dumpsys telephony.registry | grep mCallState');
        if (String(out).includes('mCallState=1')) return out;
      }
      return adbmod.shell('dumpsys telephony.registry | grep mCallState');
    },
    (r) => String(r).includes('mCallState=1')
  );
  await step('挂断来电', () => phone.call('cancel', '+8613800138000'), (r) => r.ok);
  await step('显示分辨率设置', () => dev.setDisplay({ width: 720, height: 1600, density: 320 }), (r) => r && (r.size !== undefined || r.density !== undefined));
  await sleep(800);
  await step('分辨率生效校验', () => dev.getDisplay(), (r) => r.size.includes('720x1600'));
  await step('分辨率还原', () => dev.resetDisplay(), () => true);
  await step('音量控制', () => dev.setVolume({ music: 12, ring: 5, call: 4 }), (r) => r && Object.keys(r).length === 3);
  await step('音频状态', () => dev.getAudio(), (r) => (r.volume || '').length > 0);
  await step('摄像头配置', () => dev.getCamera(), (r) => !!(r.back || r.front));
  // 不同镜像的挂载点不一样（/storage 或 /mnt/pass_through/...），只校验有真实输出
  await step('磁盘信息', () => dev.getDisk(), (r) => (r.raw || '').length > 20);
  await step('切换机型 Pixel 8 Pro', () => dev.setDevice('pixel_8_pro', {}), (r) => r.device.model === 'Pixel 8 Pro');
  await step('恢复机型 Pixel 7', () => dev.setDevice('pixel_7', {}), (r) => r.device.model === 'Pixel 7');
  await step('截屏接口', () => dev.screenshot(), (r) => r.length > 5000);

  // ---------- 摄像头模块（写 AVD 配置，末尾还原） ----------
  await step('摄像头 读取当前配置', () => camera.getStatus(), (r) => !!(r.back && r.front) && !!r.avdName);
  await step('摄像头 写入宿主机摄像头', () => camera.setSource({ back: { mode: 'webcam', index: 0 } }),
    (r) => r.ok && r.back === 'webcam0');
  await step('摄像头 回读确认已写入', () => camera.getStatus(), (r) => r.back === 'webcam0');
  await step('摄像头 切回虚拟场景', () => camera.setSource({ back: { mode: 'virtualscene' }, front: { mode: 'emulated' } }),
    (r) => r.ok && r.back === 'virtualscene');
  await step('摄像头 枚举宿主机设备', () => camera.listHostCameras(), (r) => Array.isArray(r));

  // ---------- 多开实例注册表 ----------
  await step('实例列表读取', () => instances.load(), (r) => r && Array.isArray(r.list) && r.list.length > 0);
  await step('当前活动实例', () => instances.active(), (r) => !!(r && r.id && r.avdName));
  await step('实例配置读写', () => {
    const inst = instances.active();
    const cfg = instances.loadState(inst.id);
    instances.saveState(inst.id, cfg);
    const again = instances.loadState(inst.id);
    return { ok: !!again && typeof again === 'object' };
  }, (r) => r.ok);

  const st = await vm.status();
  console.log('');
  console.log('========== 测试报告 ==========');
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log('');
  console.log(`合计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
  console.log('最终状态:', JSON.stringify({ running: st.running, online: st.online, pid: st.pid, model: st.props.model, release: st.props.release }));

  fs.writeFileSync(path.join(__dirname, '..', '_logs', 'test-report.txt'), results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}\t${r.name}\t${r.detail}`).join('\n'), 'utf8');
  return failed;
}

module.exports = { runE2E };



