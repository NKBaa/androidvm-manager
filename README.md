# Android 14 虚拟机管理器

基于 Android Emulator 的图形化管理器：**多开实例**、**真机档案伪装**、**网络/号码/短信模拟**、**Root**，界面按市面模拟器（BlueStacks / MuMu / LDPlayer）的布局重做。

![主界面](_docs/ui-device.png)

---

## 功能

### 多开实例
- 左侧实例列表，每实例独立 AVD、独立数据分区、独立端口（5554 / 5556 / …）
- 可同时运行多个实例，停止/重启/删除只作用于单个实例
- 新建实例自动克隆当前配置并分配空闲端口

### 真机档案（设备身份伪装）
- 内置 **Google Play 官方真机库**（54,328 台 / 3,879 个品牌）
- 一条命令写入 `brand / device / model / name / manufacturer` 与 `ro.build.*`，
  `ro.build.fingerprint` 会一并变化
- 可选 ARM ABI 伪装：把 `arm64-v8a` 提到 ABI 列表首位（`Build.SUPPORTED_ABIS[0]`），
  镜像自带 `libndk_translation.so`，ARM64 代码可真实执行

### 无线模拟
| 功能 | 状态 |
|---|---|
| 移动网络：信号/数据/语音/制式/漫游/运营商 | ✅ 完全可用 |
| 电话号码 / ICCID（双卡） | ✅ 完全可用 |
| 来电 / 短信注入 | ✅ 完全可用 |
| WiFi 开关 / 关联 / 状态（SSID·BSSID·RSSI） | ✅ 可用（无 IP，数据面依赖 netsim） |
| 蓝牙 | ❌ 底层 netsimd 无法启动，协议栈崩溃 |

### 网络与代理
- 10 种网络预设（2G/3G/4G/5G/WiFi/离线）+ 自定义带宽、延迟、丢包
- HTTP / HTTPS / SOCKS5 代理（自动把 `127.0.0.1` 映射为 `10.0.2.2`）

### 设备控制
- 悬浮侧边工具栏：截屏 / 安装 APK / 返回·主页·最近 / 音量 / 旋转 / 电源
- 显示分辨率、DPI、音量、摄像头、磁盘查看

### 系统镜像
| 镜像 | GMS | 桌面 UI | 可 root |
|---|---|---|---|
| `google_apis`（推荐） | ✓ | ✓ | ✓ |
| `google_apis_playstore` | ✓ | ✓ | ✗ |
| `google_atd` | ✓ | ✗ | ✓ |

---

## 快速开始

### 方式一：安装包

下载 `AndroidVM-Setup-<ver>.exe` 或 `AndroidVM-Portable-<ver>.exe`（约 76 MB）。

安装包**不含 Android SDK**（约 5.4 GB），首次启动会自动查找 SDK；
找不到时界面顶部会出现橙色提示条，点「选择 SDK 目录」选中即可。

### 方式二：源码运行

```bash
git clone <repo>
cd app
npm install

# 准备 SDK（放到项目根目录 android-sdk/）
#   emulator + platform-tools + system-images;android-34;google_apis;x86_64

cd ..
start.bat
```

---

## 准备 Android SDK

需要三个组件：

| 组件 | 大小 |
|---|---|
| `emulator` | ≈ 1.1 GB |
| `platform-tools` | ≈ 17 MB |
| `system-images;android-34;google_apis;x86_64` | ≈ 4.3 GB |

用官方 `sdkmanager` 安装：

```bash
sdkmanager "emulator" "platform-tools" "system-images;android-34;google_apis;x86_64"
```

或直接使用 Android Studio 的 SDK（程序会自动从
`%LOCALAPPDATA%\Android\Sdk` 找到）。

也可以设环境变量指定：

```powershell
$env:AVM_SDK_ROOT = "D:\Android\Sdk"
```

> **为什么 SDK 不打包进安装包？**
> 5.4 GB 超过 GitHub 单文件 2 GB 限制，也不适合放进仓库。
> 用官方 `sdkmanager` 获取是最快、最新、也最稳妥的方式。

---

## 打包

```powershell
pwsh -File _tools\build.ps1
```

产物在 `dist\`：NSIS 安装程序 + 免安装便携版。
构建环境的坑位（TEMP 不可写、符号链接权限、代码签名）见
[`_docs/打包说明.md`](_docs/打包说明.md)。

---

## 目录结构

```
├── app/                  Electron 应用
│   ├── main.js           主进程 + IPC
│   ├── preload.js        安全桥
│   ├── renderer/         界面（HTML/CSS/JS）
│   ├── src/
│   │   ├── config.js     路径解析（源码/安装包两种形态）
│   │   ├── vm.js         虚拟机生命周期（按实例隔离）
│   │   ├── instances.js  多开实例注册表
│   │   ├── adb.js        ADB 封装（AsyncLocalStorage 多目标）
│   │   ├── deviceprofile.js  真机档案引擎
│   │   ├── wifi.js / bluetooth.js / cellular.js
│   │   ├── network.js / proxy.js / phone.js / device.js
│   │   └── reapply-cli.js    独立进程补应用档案
│   └── build/            图标、rcedit、afterPack 钩子
├── _data/                真机库 + 预置档案
├── _docs/                技术文档与截图
├── _tools/               构建 / 图标 / 界面预览脚本
└── start.bat             源码模式启动
```

---

## 已知限制（诚实说明）

| 项目 | 原因 |
|---|---|
| 蓝牙不可用 | 模拟器蓝牙依赖 `netsimd`，本机启动失败（Access denied），协议栈 abort 崩溃 |
| WiFi 拿不到 IP | 数据面（DHCP/slirp）同样依赖 netsim，但 L2 关联与 SSID/RSSI 可读 |
| 过不了 Play Integrity 硬件证明 | 无真实 TEE；`/proc/cpuinfo`、`ANDROID_EMU_*` GLES 扩展、`init.svc.qemu-*` 等仍会暴露 |
| ARM 伪装会让启动变慢 | ABI 改成 arm64 优先后系统库解析变慢，引导可能从 60 秒涨到 200~470 秒 |

详见 [`_docs/真机档案.md`](_docs/真机档案.md) 与 [`_docs/无线模拟.md`](_docs/无线模拟.md)。

---

## 许可

MIT
