// 代理：HTTP / HTTPS / SOCKS5 全局代理（系统 settings + iptables 分流）
const adbmod = require('./adb');

function proxyHostForGuest(host) {
  // 模拟器内 10.0.2.2 指向宿主机回环地址
  const h = String(host || '').trim();
  if (!h) return '10.0.2.2';
  if (['127.0.0.1', 'localhost', '0.0.0.0'].includes(h)) return '10.0.2.2';
  return h;
}

async function clearProxy() {
  await adbmod.shell('settings put global http_proxy :0').catch(() => {});
  await adbmod.rootShell(
    'iptables -t nat -D OUTPUT -p tcp -m owner --uid-owner 0 -j RETURN 2>/dev/null; ' +
    'iptables -t nat -F PREROUTING 2>/dev/null; ' +
    'iptables -t nat -D OUTPUT -p tcp ! -d 10.0.2.0/24 -j REDIRECT --to-ports 0 2>/dev/null; true'
  ).catch(() => {});
}

/**
 * 设置代理
 * type: http | https | socks5 | transparent
 * system: 是否同时写入 Android 全局代理设置（HttpURLConnection / OkHttp 遵循）
 */
async function setProxy(p) {
  const cfg = p || {};
  if (!cfg.enabled || !cfg.host) {
    await clearProxy();
    return { ok: true, cleared: true };
  }
  const host = proxyHostForGuest(cfg.host);
  const port = Number(cfg.port) || (cfg.type === 'socks5' ? 1080 : 8080);
  const results = {};

  if (cfg.type !== 'socks5') {
    // Android 全局 HTTP 代理（支持 https via CONNECT）
    if (cfg.system !== false) {
      results.system = await adbmod.shell(`settings put global http_proxy ${host}:${port}`);
    }
    // 让 root 进程也走代理（Go 程序等）
    if (cfg.username) {
      const uri = `http://${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password || '')}@${host}:${port}`;
      results.env = await adbmod.rootShell(
        `cat > /data/local/tmp/proxy_env.sh <<'EOF'
export http_proxy='${uri}'
export https_proxy='${uri}'
export HTTP_PROXY='${uri}'
export HTTPS_PROXY='${uri}'
EOF
chmod 755 /data/local/tmp/proxy_env.sh; true`
      );
    }
  } else {
    // SOCKS5：Android 无全局 SOCKS 支持，使用透明重定向
    results.system = await adbmod.shell('settings put global http_proxy :0');
    const uplink = '10.0.2.2';
    results.redirect = await adbmod.rootShell(
      `iptables -t nat -C OUTPUT -p tcp -m owner --uid-owner 0 -j RETURN 2>/dev/null || ` +
      `iptables -t nat -A OUTPUT -p tcp -m owner --uid-owner 0 -j RETURN; ` +
      // 用 iptables 的 REDIRECT 无法直连 socks，需透明代理程序，这里配置 redsocks 风格规则
      `echo "socks5 ${host} ${port}" > /data/local/tmp/socks5_target.txt; ` +
      `iptables -t nat -A OUTPUT -p tcp -d ${uplink} -j RETURN; true`
    );
    results.note = 'SOCKS5 已记录到设备 /data/local/tmp/socks5_target.txt；Android 原生无全局 SOCKS 支持，'
      + '若应用支持 SOCKS 代理请在其设置内填写宿主 IP 10.0.2.2。';
  }
  results.applied = { host, port, type: cfg.type };
  return results;
}

async function getProxyStatus() {
  const v = await adbmod.shell('settings get global http_proxy').catch(() => '');
  const rules = await adbmod.rootShell('iptables -t nat -L OUTPUT -n 2>/dev/null | head -5').catch(() => '');
  return { proxySetting: v, natRules: rules };
}

module.exports = { setProxy, clearProxy, getProxyStatus, proxyHostForGuest };
