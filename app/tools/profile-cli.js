#!/usr/bin/env node
// 真机档案 CLI
//
// 用法（在 app 目录下执行）：
//   node tools/profile-cli.js db                     查看真机数据库统计
//   node tools/profile-cli.js search "Galaxy S23"    搜索真机
//   node tools/profile-cli.js list                   列出已保存档案
//   node tools/profile-cli.js show                   查看当前设备身份
//   node tools/profile-cli.js make "Galaxy S23 Ultra" "SM-S918B" <名字>   从数据库生成档案
//   node tools/profile-cli.js apply <档案名>          应用档案（需 userdebug 镜像 + -writable-system）
//   node tools/profile-cli.js revert                 还原原始身份

const dp = require('../src/deviceprofile');

const [, , cmd, ...args] = process.argv;

function out(o) {
  console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
}

async function main() {
  switch (cmd) {
    case 'db': {
      out(dp.dbStats());
      break;
    }
    case 'search': {
      const kw = args.join(' ');
      const rows = dp.searchDevices(kw, 25);
      if (!rows.length) return out(`没有匹配 "${kw}" 的真机`);
      console.log(`${rows.length} 条结果：`);
      for (const r of rows) {
        console.log(`  ${String(r.brand).padEnd(14)} ${String(r.model).padEnd(18)} ${String(r.device).padEnd(16)} ${r.marketing}`);
      }
      break;
    }
    case 'list': {
      const ps = dp.listProfiles();
      if (!ps.length) return out('还没有档案。可用 make 从数据库生成。');
      for (const p of ps) {
        console.log(`  ${String(p.file).padEnd(28)} ${p.brand}/${p.device}  ${p.model}`);
      }
      break;
    }
    case 'show': {
      out(await dp.readIdentity());
      break;
    }
    case 'make': {
      const [marketing, model, name] = args;
      if (!marketing) return out('用法: make "<Marketing Name>" ["<Model>"] [档案名]');
      const rows = dp.searchDevices(marketing, 200);
      const hit = model
        ? rows.find((r) => r.model.toLowerCase() === String(model).toLowerCase())
        : rows[0];
      if (!hit) return out(`数据库里找不到 ${marketing} ${model || ''}`);
      const profile = dp.profileFromDevice(hit);
      const file = `${(name || hit.device || 'profile').replace(/[^\w.-]/g, '_')}.json`;
      const fs = require('node:fs');
      const path = require('node:path');
      const { conf } = require('../src/config');
      const dir = path.join(conf.vmRoot, '_data', 'profiles');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), JSON.stringify(profile, null, 2), 'utf8');
      out({ created: file, profile });
      break;
    }
    case 'apply': {
      const name = args[0];
      if (!name) return out('用法: apply <档案名>');
      let profile;
      try {
        profile = dp.loadProfile(name);
      } catch {
        // 允许直接传数据库里的型号
        const rows = dp.searchDevices(name, 50);
        if (!rows.length) return out(`档案 "${name}" 不存在，数据库也搜不到`);
        profile = dp.profileFromDevice(rows[0]);
        console.log(`未找到同名档案，改用数据库首条匹配: ${profile.model}`);
      }
      console.log('即将应用档案:', JSON.stringify(profile, null, 2));
      await dp.backupProps();
      const r = await dp.applyProfile(profile);
      out(r);
      if (r.ok) console.log('\n已写入并重启。等待启动后执行 show 验证。');
      break;
    }
    case 'revert': {
      out(await dp.revertProfile());
      break;
    }
    default:
      console.log(`真机档案工具

  db                              真机数据库统计
  search <关键词>                  搜索真机
  list                            列出档案
  show                            当前设备身份
  make <型号> [model] [档案名]      从数据库生成档案
  apply <档案名>                   应用档案
  revert                          还原原始身份
`);
  }
}

main().catch((e) => {
  console.error('错误:', e.message);
  process.exit(1);
});
