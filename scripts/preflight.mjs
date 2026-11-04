// 用法：
//   node scripts/preflight.mjs              离线检查配置/人格/数据
//   node scripts/preflight.mjs --install    检查 DSH 是否真的会加载这个 bundle
//   node scripts/preflight.mjs --online     真连一次 OneBot（只 get_login_info，不发消息）
//   node scripts/preflight.mjs --profile desktop
import { preflight, pingOneBot } from '../src/preflight.js';
import { checkInstalled } from '../src/install-check.js';
import { defaultDataDir } from '../src/host.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dataDir = defaultDataDir();
const marks = { true: '✅', false: '❌' };
let failed = false;

console.log(`数据目录：${dataDir}\n`);
const r = preflight({ dataDir });
for (const c of r.checks) console.log(`${marks[c.ok]} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
failed ||= !r.ok;

if (flag('--install')) {
  const profile = valueOf('--profile', 'desktop');
  const profileDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', profile);
  console.log(`\nprofile：${profileDir}`);
  const inst = checkInstalled({ profileDir });
  for (const c of inst.checks) console.log(`${marks[c.ok]} ${c.label}${c.detail ? ' — ' + c.detail : ''}`);
  failed ||= !inst.ok;
}

if (flag('--online')) {
  const cfgFile = join(dataDir, 'config.json');
  let cfg = {};
  try { cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : {}; } catch { /* 上面报过 */ }
  const ping = await pingOneBot(cfg.onebot || {});
  console.log(`\n${marks[ping.ok]} ${ping.name}${ping.detail ? ' — ' + ping.detail : ''}`);
  failed ||= !ping.ok;
}

console.log(failed ? '\n有检查没通过，按 ❌ 那一行修。' : '\n都通过了。');
process.exit(failed ? 1 : 0);
