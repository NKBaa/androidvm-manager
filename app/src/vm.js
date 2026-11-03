// 虚拟机生命周期管理：启动 / 停止 / 状态 / 配置持久化
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { conf, ensureDirs, seedAvdConfig } = require('./config');
const adbmod = require('./adb');

const STATE_FILE = path.join(conf.vmRoot, 'app', 'state.json');
const LOG_FILE = path.join(conf.logDir, 'emulator.log');

function readIni(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function writeIni(file, obj) {
  // 目录可能还不存在（全新安装时 avd/<name>.avd 还没建），必须先建
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = Object.entries(obj)
    .map(([k, v]) => `${k}=${v === undefined || v === null ? '' : v}`)
    .join('\n');
  fs.writeFileSync(file, text, 'utf8');
}

/**
 * 单实例管理器。
 * inst = { id, name, avdName, port, stateFile?, logFile? }
 * 不传则退回旧的单实例行为（A14_Root / 5554 / app/state.json）。
 */
class VmManager {
  constructor(inst = {}) {
    this.inst = inst;
    this.id = inst.id || 'main';
    this.name = inst.name || '主实例';
    this.avdName = inst.avdName || conf.avdName;
    this.port = Number(inst.port) || conf.consolePort;
    this.serial = 'emulator-' + this.port;
    this.stateFile = inst.stateFile || STATE_FILE;
    this.logFile = inst.logFile || LOG_FILE;
    this.proc = null;
    this.state = { running: false, booting: false, bootSeconds: 0, startedAt: 0, error: null };
    this.pendingId = null;
    ensureDirs();
  }

  /** 在"本实例"的 adb 上下文里执行（多开并发时不会串号） */
  withSelf(fn) {
    return adbmod.withTarget(this.serial, this.port, fn);
  }

  get avdDir() {
    return path.join(conf.avdHome, this.avdName + '.avd');
  }

  get configPath() {
    return path.join(this.avdDir, 'config.ini');
  }

  /** AVD 定义文件（<avdName>.ini），指向 avdDir 并声明 target */
  get iniPath() {
    return path.join(conf.avdHome, this.avdName + '.ini');
  }

  /** 当前配置对应的系统镜像 */
  get imageInfo() {
    const cfg = this.loadState() || {};
    return conf.images[cfg.engine] || conf.images.playstore;
  }

  /**
   * 校验并修复 AVD 定义文件。
   * 若 <avdName>.ini 的 path 指向不存在的目录，模拟器会回退到 "arm" 架构并直接 FATAL 退出
   * （日志：Failed to process .ini file config.ini / Found AVD target architecture: arm）。
   */
  ensureAvdIni() {
    const want = this.avdDir;
    const body = `avd.ini.encoding=UTF-8\npath=${want}\ntarget=android-34\n`;
    let need = true;
    try {
      const cur = readIni(this.iniPath);
      if (cur.path && path.resolve(cur.path).toLowerCase() === path.resolve(want).toLowerCase()) {
        need = false;
      }
    } catch {}
    if (need) {
      fs.mkdirSync(conf.avdHome, { recursive: true });
      fs.writeFileSync(this.iniPath, body, 'utf8');
      return { repaired: true, path: want };
    }
    return { repaired: false, path: want };
  }

  /**
   * 切换系统镜像（Play 商店镜像 / ATD 精简镜像）。
   * 重要：不同镜像的 userdata 不兼容，切换后必须清空 userdata，
   * 否则模拟器会卡在引导阶段（实测：Play 的 userdata 配 ATD 镜像无法启动）。
   */
  setEngine(engine, { keepData = false } = {}) {
    const info = conf.images[engine];
    if (!info) throw new Error(`未知镜像: ${engine}`);
    const imgDir = path.join(conf.sdkRoot, info.dir);
    if (!fs.existsSync(path.join(imgDir, 'system.img'))) {
      throw new Error(`镜像未安装: ${info.id}（请运行 sdkmanager 安装后再切换）`);
    }
    const st = this.loadState() || {};
    const prev = st.engine;
    st.engine = engine;
    st.image = info.id;
    this.saveState({ ...conf.defaultConfig, ...st });

    let dataReset = false;
    if (prev && prev !== engine && !keepData) {
      dataReset = this.resetUserdata();
    }
    // 立即把镜像路径写进 AVD 的 config.ini，避免直接命令行启动时仍用旧镜像
    try {
      this.ensureAvdIni();
      this.applyConfigToAvd(this.getConfig());
    } catch {}
    return { ...info, previousEngine: prev || null, dataReset };
  }

  /** 清空用户数据分区（恢复出厂；跨镜像切换时必须做） */
  resetUserdata() {
    let n = 0;
    for (const f of ['userdata-qemu.img', 'userdata-qemu.img.qcow2', 'hardware-qemu.ini']) {
      try {
        fs.rmSync(path.join(this.avdDir, f), { force: true });
        n++;
      } catch {}
    }
    return n > 0;
  }

  loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return null;
    }
  }

  saveState(s) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(s, null, 2), 'utf8');
  }

  /** 合并默认配置与已保存配置 */
  getConfig() {
    const saved = this.loadState() || {};
    const base = JSON.parse(JSON.stringify(conf.defaultConfig));
    const merged = { ...base, ...saved };
    for (const k of ['resolution', 'gpu', 'audio', 'camera', 'network', 'proxy', 'phone']) {
      merged[k] = { ...base[k], ...(saved[k] || {}) };
    }
    return merged;
  }

  applyConfigToAvd(cfg) {
    // 全新安装的机器上没有 AVD 目录，先从随包模板生成一份完整配置，
    // 否则模拟器缺 abi.type / hw.cpu.arch / image.sysdir.1 会回退到 arm 直接 FATAL
    fs.mkdirSync(this.avdDir, { recursive: true });
    const seeded = seedAvdConfig(this.avdDir);
    if (seeded.created) {
      console.log(`[vm] 已从模板生成 AVD 配置: ${this.avdDir}${seeded.fallback ? '（内置最小配置）' : ''}`);
    }

    const ini = readIni(this.configPath);
    const dev = conf.devices[cfg.deviceKey] || conf.devices.pixel_7;
    const img = conf.images[cfg.engine] || conf.images.playstore;
    ini['hw.ramSize'] = String(cfg.ram || 4096);
    ini['hw.cpu.ncore'] = String(cfg.cores || 4);
    ini['disk.dataPartition.size'] = `${cfg.diskGB || 6}G`;
    ini['hw.lcd.width'] = String(cfg.resolution.width);
    ini['hw.lcd.height'] = String(cfg.resolution.height);
    ini['hw.lcd.density'] = String(cfg.resolution.density);
    ini['hw.device.name'] = dev.profile;
    ini['hw.device.manufacturer'] = dev.brand === 'samsung' ? 'samsung' : dev.brand === 'Xiaomi' ? 'Xiaomi' : 'Google';
    ini['hw.gpu.enabled'] = cfg.gpu.enabled ? 'yes' : 'no';
    ini['hw.gpu.mode'] = cfg.gpu.mode || 'host';
    ini['hw.audioInput'] = cfg.audio.input ? 'yes' : 'no';
    ini['hw.audioOutput'] = cfg.audio.output ? 'yes' : 'no';
    ini['hw.camera.back'] = cfg.camera.back || 'virtualscene';
    ini['hw.camera.front'] = cfg.camera.front || 'emulated';

    // AVD 身份：克隆出来的 config.ini 会带着源 AVD 的 id/name，必须覆盖成本实例的，
    // 否则模拟器可能认错 AVD
    ini['avd.id'] = this.avdName;
    ini['avd.name'] = this.avdName;
    ini['avd.ini.encoding'] = 'UTF-8';

    // 系统镜像：必须与 engine 一致，否则模拟器按旧镜像启动（表现为黑屏 / 无 UI）
    ini['image.sysdir.1'] = img.dir;
    ini['tag.id'] = img.tag;
    ini['tag.display'] = img.tagDisplay;
    ini['PlayStore.enabled'] = img.playStore;
    writeIni(this.configPath, ini);
  }

  /**
   * 清掉上次异常退出的残留文件，避免启动卡死。
   * 注意：绝不能删除 userdata-qemu.img —— 那是用户数据分区，
   * 删掉会让 Play 商店登录状态、已装应用、短信号码等全部丢失。
   */
  cleanStale() {
    const junk = [
      'hardware-qemu.ini.lock', 'multiinstance.lock', 'hardware-qemu.ini',
      'emu-launch-params.txt', 'version_num.cache', 'initrd', 'data',
      'bootcompleted.ini', 'tmpAdbCmds', 'read-snapshot.txt',
    ];
    for (const f of junk) {
      try { fs.rmSync(path.join(this.avdDir, f), { recursive: true, force: true }); } catch {}
    }
    // 重要：这里**不再删除任何 .qcow2 文件**。
    // 踩过的坑：
    //   1) userdata-qemu.img.qcow2 是用户数据分区，删了等于每次开机恢复出厂；
    //      而且用 -writable-system 做的 build.prop 改写（overlayfs）也落在 /data 里，
    //      删掉它会让真机档案伪装在每次启动后丢失。
    //   2) encryptionkey.img.qcow2 存的是 userdata 的加密密钥，
    //      删掉后 userdata 无法解密，模拟器会卡在引导阶段（实测）。
    // 需要真正重置时请显式调用 resetUserdata()。
  }

  /** 构建 emulator 启动参数 */
  buildArgs(cfg) {
    const hidden = !cfg.window || cfg.window === 'hidden';
    const img = conf.images[cfg.engine] || conf.images.playstore;
    // 实测：swiftshader_indirect 在本机（双显卡 RTX 4070 + Intel Xe）会导致
    // 整个画面合成输出全黑（screencap 只有 15KB 纯黑图）。host 模式可正常工作。
    const gpuMode = (cfg.gpu && cfg.gpu.mode) || 'host';
    const args = [
      '-avd', this.avdName,
      '-gpu', gpuMode,
      '-port', String(this.port),
      '-no-metrics',
      '-no-boot-anim',
    ];
    // 关键：Play 商店镜像上即使用 -no-window 也能正常渲染（screencap 有画面），
    // 因此后台模式与可见窗口都保留硬件合成；不要为隐藏模式强制降级为软件渲染。
    if (hidden) args.push('-no-window');
    // Play 商店镜像（user 版本，ro.adb.secure=1）首次连接会在设备端弹出
    // 「允许 USB 调试」对话框；后台运行时用户点不到，会一直停在 unauthorized。
    // -skip-adb-auth 是模拟器官方参数，跳过该授权对话。
    if (img.adbSecure) args.push('-skip-adb-auth');
    if (!cfg.audio.host) args.push('-no-audio');
    if (!cfg.audio.output) args.push('-no-audio-output');
    if (!cfg.audio.input) args.push('-no-audio-input');
    if (cfg.writableSystem) args.push('-writable-system');
    if (cfg.root) args.push('-shell');
    if (cfg.snapshot) args.push('-snapshot', 'default');
    else args.push('-no-snapshot-save');
    args.push('-skin', `${cfg.resolution.width}x${cfg.resolution.height}`);
    return args;
  }

  /**
   * 查找本实例的模拟器进程 PID。
   * 多开时必须按控制台端口反查，不能按进程名找 ——
   * 按名字会拿到别的实例，误杀后所有虚拟机一起关闭。
   */
  findEmulatorPid() {
    if (this.proc && this.proc.pid) return this.proc.pid;
    try {
      const { execFileSync } = require('node:child_process');
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      const re = new RegExp(`:${this.port}\\s`);
      for (const line of out.split('\n')) {
        if (!re.test(line)) continue;
        if (!/LISTENING/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (pid) return pid;
      }
    } catch {}
    return null;
  }

  async isPortInUse(port) {
    return new Promise((resolve) => {
      const sock = require('node:net').createConnection(port, '127.0.0.1');
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.setTimeout(800, () => { sock.destroy(); resolve(false); });
    });
  }

  async start(opts = {}) {
    if (this.state.running) return { ok: true, already: true, state: this.state };
    const cfg = { ...this.getConfig(), ...opts };
    if (opts.network) cfg.network = { ...this.getConfig().network, ...opts.network };

    // 镜像没装就别往下走：否则模拟器只会黑屏或 FATAL，用户看不出真正原因
    const img = conf.images[cfg.engine];
    if (!img) throw new Error(`未知系统镜像: ${cfg.engine}`);
    const imgDir = path.join(conf.sdkRoot, img.dir);
    if (!fs.existsSync(path.join(imgDir, 'system.img'))) {
      throw new Error(
        `系统镜像未安装：${img.id}\n\n` +
          `请用界面上的「在线下载 SDK」安装，或在「设备设置 → 机型」里切换到已安装的镜像。`
      );
    }

    this.saveState(cfg);
    // 先修好 AVD 定义文件，再写 config.ini：顺序反了会导致模拟器按错误的 AVD 目录启动
    const iniFix = this.ensureAvdIni();
    this.applyConfigToAvd(cfg);
    // 不同镜像的 userdata 不兼容：用标记文件记录 userdata 属于哪个镜像，
    // 不一致就清空，否则模拟器会卡在引导阶段（实测）。
    const engineMark = path.join(this.avdDir, '.engine');
    let markEngine = '';
    try { markEngine = fs.readFileSync(engineMark, 'utf8').trim(); } catch {}
    if (markEngine && markEngine !== cfg.engine) {
      this.resetUserdata();
      this.applyConfigToAvd(cfg);
    }
    try { fs.writeFileSync(engineMark, String(cfg.engine || ''), 'utf8'); } catch {}
    this.cleanStale();
    // 强制重启 adb server：确保 ADB_VENDOR_KEYS 指向项目内的 adbkey，
    // 否则 Play 商店镜像（user 版本）会一直停在 unauthorized。
    await adbmod.startAdbServer(true);

    const args = this.buildArgs(cfg);
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    const out = fs.openSync(this.logFile, 'w');
    // detached + unref：应用退出后虚拟机继续运行（独立会话，不受父进程生命周期影响）
    const child = spawn(conf.emulator, args, {
      env: adbmod.adbEnv(),
      stdio: ['ignore', out, out],
      detached: true,
      windowsHide: true,
    });
    child.unref();
    this.proc = child;
    this.state = { running: true, booting: true, bootSeconds: 0, startedAt: Date.now(), error: null, args, engine: cfg.engine, avdIniRepaired: iniFix.repaired };

    child.on('exit', (code) => {
      this.proc = null;
      this.state.running = false;
      this.state.booting = false;
      this.state.exitCode = code;
    });
    child.on('error', (e) => {
      this.state.error = e.message;
      this.state.running = false;
    });

    // 后台等待启动完成（绑定本实例的 serial，多开时不会互相干扰）
    const self = this;
    this.bootPromise = this.withSelf(() =>
      adbmod.waitForBoot(300000, (s) => { self.state.bootSeconds = s; }, self.serial).then(async (ok) => {
        self.state.booting = false;
        self.state.booted = ok;
        if (ok) {
          await self.postBoot(cfg);
          self.state.postBootDone = true;
          // 真机档案自动补应用放到**独立子进程**里跑：
          //  1) 不阻塞启动就绪（补应用最多要重启 3 轮，会拖几分钟）
          //  2) detached 后即使 App 被关掉也能跑完（overlayfs 改动不跨进程重启，每次冷启动都要重写）
          self.state.profileCheck = 'pending';
          try {
            const cli = path.join(__dirname, 'reapply-cli.js');
            const logFd = fs.openSync(path.join(conf.logDir, `reapply-${self.id}.log`), 'w');
            const child = spawn(process.execPath, [cli, self.serial, String(self.port)], {
              env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
              stdio: ['ignore', logFd, logFd],
              detached: true,
              windowsHide: true,
            });
            child.unref();
            child.on('exit', (code) => {
              self.state.profileCheck = code === 0 ? 'done' : 'failed(' + code + ')';
            });
          } catch (e) {
            self.state.profileCheck = 'spawn-error: ' + e.message;
          }
        }
        return ok;
      })
    );

    return { ok: true, args, id: this.id, serial: this.serial };
  }

  /** 等待启动 + postBoot 完成（供界面/脚本调用） */
  async waitReady(timeoutMs = 300000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.state.postBootDone) return true;
      if (this.bootPromise) {
        const ok = await Promise.race([
          this.bootPromise,
          new Promise((r) => setTimeout(() => r(null), 3000)),
        ]);
        if (ok === true && this.state.postBootDone) return true;
      } else if (await this.withSelf(() => adbmod.isOnline(this.serial))) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return this.state.postBootDone === true;
  }

  async postBoot(cfg) {
    // 整个 postBoot 都在本实例的 adb 上下文里执行
    return this.withSelf(() => this._postBoot(cfg));
  }

  async _postBoot(cfg) {
    const img = conf.images[cfg.engine] || conf.images.playstore;
    const isPlay = img.engine === 'playstore';
    try {
      await adbmod.shell('settings put global window_animation_scale 0.5');
      await adbmod.shell('settings put global transition_animation_scale 0.5');
      await adbmod.shell('settings put secure immersive_mode_confirmations confirmed');

      // Root：userdebug 镜像（ATD）adb root 后 shell 为 uid=0；
      // user 版本镜像（Play 商店）不支持 adb root，只能保留普通 shell。
      if (cfg.root && !img.adbSecure) {
        await adbmod.adb(['root'], { allowFail: true, timeout: 15000 });
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const uid = (await adbmod.shell('id -u').catch(() => '')).trim();
          if (uid === '0') break;
        }
        this.state.rootReady = (await adbmod.shell('id -u').catch(() => '')).trim() === '0';
      } else {
        this.state.rootReady = (await adbmod.shell('id -u').catch(() => '')).trim() === '0';
      }

      // 保持屏幕常亮，便于随时截屏查看
      await adbmod.rootShell('svc power stayon true');

      if (isPlay) {
        // Play 镜像自带完整桌面：解锁屏幕并回到桌面，避免停在锁屏
        await adbmod.shell('input keyevent KEYCODE_WAKEUP').catch(() => {});
        await adbmod.shell('wm dismiss-keyguard').catch(() => {});
        await adbmod.shell('input keyevent KEYCODE_HOME').catch(() => {});
      } else {
        // ATD 镜像无启动器，拉起系统文件选择器作为可交互前台
        await adbmod.shell(
          'am start -n com.google.android.documentsui/com.android.documentsui.LauncherActivity 2>&1 | head -1'
        ).catch(() => {});
      }

      // 等 GMS 完成首轮初始化，否则 Play 商店会长时间停在空白页
      if (isPlay) {
        for (let i = 0; i < 20; i++) {
          const running = await adbmod
            .shell('pidof com.google.android.gms 2>/dev/null')
            .catch(() => '');
          if (running.trim()) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }

      // 应用网络配置
      const { setNetwork } = require('./network');
      await setNetwork(cfg.network);
      // 应用代理
      const { setProxy } = require('./proxy');
      await setProxy(cfg.proxy);
      // 应用号码
      const { setPhoneNumber } = require('./phone');
      await setPhoneNumber(cfg.phone);

      // netsimd 起不来时蓝牙栈会反复崩溃，系统不停弹「Bluetooth keeps stopping」。
      // 检测到这种情况就把蓝牙应用禁掉，止住弹窗（本来也用不了）。
      try {
        const log = String(this.readLog(4000) || '');
        if (/Netsim daemon failed to start/i.test(log)) {
          const bt = require('./bluetooth');
          const r = await bt.suppressCrash();
          if (r && r.ok) console.log('[vm] netsimd 不可用，已禁用蓝牙应用以止住崩溃弹窗');
        }
      } catch (e) {
        console.warn('[vm] 抑制蓝牙崩溃弹窗失败:', e.message);
      }
    } catch (e) {
      this.state.error = 'postBoot: ' + e.message;
    }
  }

  async stop() {
    return this.withSelf(() => this._stop());
  }

  async _stop() {
    const pidBefore = this.findEmulatorPid();
    // 1) 优雅关闭：只关本实例（用 -s 指定序列号，绝不能发到所有设备）
    try {
      const r = await adbmod.adb(['emu', 'kill'], { allowFail: true, timeout: 8000 });
      if (!/OK|OKAY/i.test(r.stdout + r.stderr)) {
        await adbmod.consoleCmd(['kill']).catch(() => {});
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));

    // 2) 兜底：只杀本实例的进程（按控制台端口反查 PID），
    //    绝不能按进程名杀 —— 那会把其它正在运行的实例一起关掉。
    if (pidBefore && this.findEmulatorPid() === pidBefore) {
      await new Promise((res) => {
        execFile('taskkill', ['/F', '/PID', String(pidBefore)], () => res());
      });
      await new Promise((r) => setTimeout(r, 1500));
    }
    this.state.running = false;
    this.state.booting = false;
    this.proc = null;
    await new Promise((r) => setTimeout(r, 1500));
    return { ok: true, pid: pidBefore, stopped: !this.findEmulatorPid() };
  }

  async restart() {
    await this.stop();
    await new Promise((r) => setTimeout(r, 3000));
    return this.start();
  }

  async status() {
    return this.withSelf(() => this._status());
  }

  async _status() {
    const online = await adbmod.isOnline(this.serial).catch(() => false);
    let props = {};
    if (online) {
      const raw = await adbmod.shell(
        'getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.model; ' +
        'getprop ro.product.brand; getprop ro.product.device; id -u; getprop ro.build.fingerprint'
      ).catch(() => '');
      const [release, sdk, model, brand, device, uid, fingerprint] = raw.split('\n');
      props = { release, sdk, model, brand, device, root: uid === '0' || uid === '0\r', fingerprint };
    }
    return {
      ...this.state,
      id: this.id,
      name: this.name,
      avdName: this.avdName,
      online,
      adbDevice: online,
      props,
      uptime: this.state.startedAt ? Math.round((Date.now() - this.state.startedAt) / 1000) : 0,
      logFile: this.logFile,
      pid: this.findEmulatorPid(),
      consolePort: this.port,
      serial: this.serial,
    };
  }

  readLog(lines = 200) {
    try {
      const txt = fs.readFileSync(this.logFile, 'utf8');
      return txt.split(/\r?\n/).filter((l) => l && !l.includes('Unexpected error while creating')).slice(-lines).join('\n');
    } catch {
      return '';
    }
  }
}

module.exports = { VmManager, readIni, writeIni };
