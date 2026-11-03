// 完整功能验证：停止 -> 窗口模式启动 -> 全功能 -> 输出报告
const fs = require('node:fs');
const path = require('node:path');
const { VmManager } = require('./src/vm');
const adbmod = require('./src/adb');
const net = require('./src/network');
const prox = require('./src/proxy');
const phone = require('./src/phone');
const dev = require('./src/device');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function runE2E() {
  const vm = new VmManager();
  let failed = 0;
  const step = async (name, fn, verify) => {
    process.stdout.write(`[${String(results.length + 1).padStart(2, '0')}] ${name} ... `);
    try {
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

  await step('等待系统启动并完成初始化(root/网络/号码)', async () => {
    const ok = await vm.waitReady(300000);
    return ok && (await adbmod.shell('getprop sys.boot_completed')) === '1';
  }, (r) => r === true);

  await step('读取系统版本', () => dev.getDeviceInfo(), (r) => r.release.trim() === '14' && r.sdk.trim() === '34');
  await step('谷歌服务(GMS)', () => adbmod.shell("pm list packages | grep com.google.android.gms"), (r) => r.includes('com.google.android.gms'));
  await step('Play 商店(vending)', () => adbmod.shell("pm list packages | grep com.android.vending"), (r) => r.includes('com.android.vending'));
  await step('Root 权限', () => dev.getRootStatus(), (r) => r.root === true && r.uid === '0');
  await step('网络限速 2G', () => net.setNetwork({ profile: 'gsm', radioType: 'GSM' }), (r) => !!r.speed);
  await step('2G 生效校验', () => net.getNetworkStatus(), (r) => /download speed:\s+14400/.test(r.console || ''));
  await step('恢复 WiFi 带宽', () => net.setNetwork({ profile: 'wifi', radioType: 'LTE' }), (r) => !!r.speed);
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
  await step('模拟来电', () => phone.call('call', '+8613800138000'), (r) => r.ok);
  await sleep(2500);
  await step('来电状态校验', () => adbmod.shell('dumpsys telephony.registry | grep -m1 mCallState'), (r) => r.includes('mCallState=1'));
  await step('挂断来电', () => phone.call('cancel', '+8613800138000'), (r) => r.ok);
  await step('恢复满格信号', () => phone.signal(4), (r) => r.ok);
  await step('显示分辨率设置', () => dev.setDisplay({ width: 720, height: 1600, density: 320 }), (r) => r && (r.size !== undefined || r.density !== undefined));
  await step('分辨率生效校验', () => dev.getDisplay(), (r) => r.size.includes('720x1600'));
  await step('分辨率还原', () => dev.resetDisplay(), () => true);
  await step('音量控制', () => dev.setVolume({ music: 12, ring: 5, call: 4 }), (r) => r && Object.keys(r).length === 3);
  await step('音频状态', () => dev.getAudio(), (r) => (r.volume || '').length > 0);
  await step('摄像头配置', () => dev.getCamera(), (r) => !!(r.back || r.front));
  await step('磁盘信息', () => dev.getDisk(), (r) => (r.raw || '').includes('/storage'));
  await step('切换机型 Pixel 8 Pro', () => dev.setDevice('pixel_8_pro', {}), (r) => r.device.model === 'Pixel 8 Pro');
  await step('恢复机型 Pixel 7', () => dev.setDevice('pixel_7', {}), (r) => r.device.model === 'Pixel 7');
  await step('截屏接口', () => dev.screenshot(), (r) => r.length > 5000);

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



