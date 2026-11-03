// 电话 / 短信：号码写入 + 短信注入（直接操作 telephony 数据库）
const adbmod = require('./adb');

const DB_DIR = '/data/user_de/0/com.android.providers.telephony/databases';
const MMSSMS = `${DB_DIR}/mmssms.db`;
const TELEPHONY = `${DB_DIR}/telephony.db`;

function sqlQuote(s) {
  return String(s).replace(/'/g, "''");
}

/** 执行 sqlite 语句（通过临时文件避免引号转义问题） */
async function sqliteUpdate(db, sql) {
  const b64 = Buffer.from(sql + '\n', 'utf8').toString('base64');
  const cmd =
    `echo '${b64}' | base64 -d > /data/local/tmp/_q.sql && ` +
    `sqlite3 '${db}' < /data/local/tmp/_q.sql; rc=$?; ` +
    `rm -f /data/local/tmp/_q.sql; echo "EXIT=$rc"`;
  const out = await adbmod.rootShell(cmd);
  return out.replace(/EXIT=\s*\nEXIT=/, 'EXIT=');
}

async function sqliteQuery(db, sql) {
  const b64 = Buffer.from(sql + '\n', 'utf8').toString('base64');
  const cmd =
    `echo '${b64}' | base64 -d > /data/local/tmp/_q.sql && ` +
    `sqlite3 '${db}' < /data/local/tmp/_q.sql 2>&1; ` +
    `rm -f /data/local/tmp/_q.sql`;
  return adbmod.rootShell(cmd);
}

/**
 * 设置号码 / IMSI / ICCID / 运营商
 * Android 14 的号码以 SubscriptionDatabase(siminfo) 为准
 */
async function setPhoneNumber(phone) {
  const p = phone || {};
  const number = String(p.number || '').replace(/[\s-]/g, '');
  const results = {};
  if (!number) return { ok: false, error: '号码为空' };

  // 1) siminfo 表：number / display_name
  const operator = p.operator || 'T-Mobile';
  const iccid = p.iccid || '';
  const sql =
    `UPDATE siminfo SET number='${sqlQuote(number)}', display_name='${sqlQuote(operator)}'` +
    (iccid ? `, icc_id='${sqlQuote(iccid)}'` : '') +
    ` WHERE _id=1;`;
  results.siminfo = await sqliteUpdate(TELEPHONY, sql);

  // 2) 系统属性（部分应用与拨号盘读取）
  results.props = await adbmod.rootShell(
    `setprop gsm.sim.number1 '${number}'; ` +
    `setprop gsm.operator.alpha '${operator}'; ` +
    `setprop gsm.sim.operator.alpha '${operator}'; ` +
    `setprop persist.sys.sim.number '${number}'; true`
  );

  // 3) 通知系统账号/电话应用刷新
  await adbmod.shell('am broadcast -a android.intent.action.USER_STARTED 2>/dev/null | head -1');

  // 4) 立即重启电话进程，让订阅信息重新加载
  results.reload = await adbmod.rootShell(
    'killall com.android.phone 2>/dev/null; sleep 1; ' +
    'am start -n com.android.phone/.TelephonyDebugService 2>/dev/null; true'
  );

  // 5) 校验
  results.current = await sqliteQuery(TELEPHONY, 'SELECT number FROM siminfo WHERE _id=1;');
  return { ok: true, number, operator, ...results };
}

async function getPhoneNumber() {
  const sub = await sqliteQuery(TELEPHONY, 'SELECT _id,number,display_name,icc_id,carrier_name FROM siminfo WHERE _id=1;')
    .catch((e) => e.message);
  const props = await adbmod.shell(
    'getprop gsm.network.type; getprop gsm.operator.alpha; getprop gsm.sim.state; getprop persist.radio.rat.override'
  ).catch(() => '');
  const [networkType, operator, simState, ratOverride] = props.split('\n');
  const [id, number, displayName, iccid, carrier] = (sub || '').split('|');
  return { number, operator: displayName || operator, carrier, iccid, simState, networkType, ratOverride };
}

/** 来电 / 挂断 / 忙（模拟器控制台） */
async function call(action, number = '') {
  const map = {
    call: `gsm call ${number}`,
    accept: `gsm accept ${number}`,
    cancel: `gsm cancel ${number}`,
    busy: `gsm busy ${number}`,
    hold: 'gsm hold',
  };
  if (!map[action]) throw new Error('未知通话操作: ' + action);
  const out = await adbmod.consoleCmd([map[action]]);
  return { ok: /\bOK\b/.test(out), raw: out.trim() };
}

/** 信号强度 0-4 */
async function signal(level) {
  const lv = Math.max(0, Math.min(4, Number(level)));
  const out = await adbmod.consoleCmd([`gsm signal-profile ${lv}`]);
  // 同时写入属性，供状态栏与应用读取
  await adbmod.rootShell(`setprop gsm.signal.level ${lv}; true`).catch(() => {});
  return { ok: /\bOK\b/.test(out), level: lv, raw: out.trim() };
}

async function networkStatus(action) {
  const out = await adbmod.consoleCmd([`gsm data ${action || 'home'}`]);
  return { ok: /\bOK\b/.test(out), action: action || 'home', raw: out.trim() };
}

/**
 * 注入短信：直接写入 mmssms.db 的 sms 表 + 广播
 * 支持中文（UTF-8 经 base64 传输）
 */
async function receiveSms(from, text) {
  const number = String(from || '').replace(/\s/g, '');
  const body = String(text || '');
  const now = Date.now();
  const b64 = Buffer.from(body, 'utf8').toString('base64');

  // 线程：同一号码复用同一 thread_id
  const sql = `
INSERT OR IGNORE INTO threads (_id, date, message_count, recipient_ids, snippet, read, archived)
  VALUES ((SELECT COALESCE(MAX(_id),0)+1 FROM threads), ${now}, 1, '${sqlQuote(number)}', '', 0, 0);
INSERT INTO sms (address, body, date, date_sent, thread_id, read, seen, type, creator)
  VALUES ('${sqlQuote(number)}',
          (SELECT CAST(readfile('/data/local/tmp/_sms.txt') AS TEXT)),
          ${now}, ${now},
          (SELECT MAX(_id) FROM threads), 0, 0, 1, NULL);
`.trim();

  const cmd =
    `echo '${b64}' | base64 -d > /data/local/tmp/_sms.txt && ` +
    `echo '${Buffer.from(sql, 'utf8').toString('base64')}' | base64 -d > /data/local/tmp/_sms.sql && ` +
    `chown radio:radio /data/local/tmp/_sms.txt; ` +
    `sqlite3 '${MMSSMS}' < /data/local/tmp/_sms.sql 2>&1; rc=$?; ` +
    `rm -f /data/local/tmp/_sms.sql; echo "EXIT=$rc"`;
  const out = await adbmod.rootShell(cmd);

  // 广播给短信应用（需系统权限，失败不阻塞）
  await adbmod.rootShell(
    `am broadcast -a android.provider.Telephony.SMS_RECEIVED --receiver-foreground ` +
    `-n com.android.messaging/.ui.conversation.ConversationActivity 2>/dev/null | head -1; true`
  ).catch(() => {});

  const ok = /EXIT=0/.test(out);
  return { ok, from: number, length: body.length, raw: out.trim() };
}

/** 读取设备短信 */
async function listSms(limit = 20) {
  const out = await sqliteQuery(
    MMSSMS,
    `SELECT _id,address,replace(body,char(10),' '),date,type FROM sms ORDER BY date DESC LIMIT ${Number(limit)};`
  ).catch((e) => e.message);
  return out
    .split('\n')
    .filter((l) => l.includes('|'))
    .map((l) => {
      const parts = l.split('|');
      const [id, address, body, date, type] = parts;
      return { id: Number(id), address, body: parts.slice(2, -2).join('|'), date: Number(date), inbox: type === '1' };
    });
}

module.exports = { setPhoneNumber, getPhoneNumber, call, signal, networkStatus, receiveSms, listSms };
