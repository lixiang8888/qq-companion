// 装完之后跑这个：node scripts/verify-live.mjs [--port 12045]
import { checkInstalled } from '../src/install-check.js';
import { checkPanel, verdict, DEFAULT_BASE } from '../src/live-check.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const i = args.indexOf('--port');
const port = i >= 0 && args[i + 1] ? args[i + 1] : new URL(DEFAULT_BASE).port;
const baseUrl = `http://127.0.0.1:${port}`;
const profileDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop');

const marks = { true: '✅', false: '❌' };
let failed = false;

const inst = checkInstalled({ profileDir });
for (const c of inst.checks) console.log(`${marks[c.ok]} ${c.label}${c.detail ? ' — ' + c.detail : ''}`);
failed ||= !inst.ok;

const panel = await checkPanel({ baseUrl });
console.log(`\n${marks[panel.ok]} 插件接口 ${panel.url}${panel.ok ? '' : ' — ' + panel.detail}`);
if (panel.ok) {
  console.log(`   网关 ${panel.gateway} · 会话 ${panel.session} 轮 · 记忆 ${panel.memory} 条 · 人格 ${panel.persona}`);
}
console.log(`\n${verdict(panel)}`);
failed ||= !panel.ok;

process.exit(failed ? 1 : 0);
