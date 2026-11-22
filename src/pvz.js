// 真游戏的外壳：无头 Edge 打开 assets/pvz/index.html，走 CDP 读战况、下指令。
//
// 为什么是浏览器：这个复刻版是一个 81 KB 的单文件页面，DOM 就是棋盘，
// gameState / selectPlant / placePlant 都在全局作用域里——所以不需要「看图点鼠标」，
// 读状态和下单都是直接调它自己的函数。她只负责决定「种什么、种哪」。
//
// 依赖：Node 自带的全局 WebSocket + 本机 Edge/Chrome。没有新依赖。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const GAME_FILE = join(HERE, '..', 'assets', 'pvz', 'index.html');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/** 本机哪个浏览器能开无头。没有就返回空串（上层据此跳过，不报错）。 */
export function findBrowser(exists = existsSync) {
  return BROWSERS.find((p) => exists(p)) || '';
}

/** 页面里的战况。只读，不改游戏。 */
const STATE_JS = `(() => {
  try {
    if (typeof gameState === 'undefined') return JSON.stringify({ ready: false });
    const s = gameState;
    const cw = (s.cellSize && s.cellSize.width) || 1;
    return JSON.stringify({
      ready: true,
      sun: s.sun, wave: s.wave, maxWaves: s.maxWaves, score: s.score,
      defeated: s.zombiesDefeated, paused: s.isPaused,
      over: s.isGameOver, victory: s.isVictory,
      plants: (s.plants || []).filter((p) => p.element)
        .map((p) => ({ row: p.row, col: p.col, type: p.type })),
      zombies: (s.zombies || []).filter((z) => z.element && z.health > 0)
        .map((z) => ({ row: z.row, col: Math.round((z.x / cw) * 10) / 10, type: z.type, health: z.health })),
    });
  } catch (e) { return JSON.stringify({ ready: false, error: String(e && e.message || e) }); }
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 开一个游戏实例。open() 起浏览器；close() 一定要调（杀进程 + 删临时 profile）。
 * 所有失败都抛出来，由 host 记日志：她这次不玩，但下一次还能玩。
 */
export function createPvz({
  edge = '', gameFile = GAME_FILE, log = console, spawnImpl = spawn,
  port = 9300 + (process.pid % 80), openTimeoutMs = 20000, now = Date.now,
} = {}) {
  let child = null;
  let profileDir = '';
  let ws = null;
  let seq = 0;
  let closing = false;
  const pending = new Map();
  const alive = () => Boolean(child) && !child.killed;

  async function httpJson(path) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`CDP ${path} → HTTP ${res.status}`);
    return res.json();
  }

  async function send(method, params = {}) {
    if (!ws || ws.readyState !== 1) throw new Error('CDP 没连上');
    const id = (seq += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (out?.exceptionDetails) throw new Error(`页面报错：${out.exceptionDetails.text || 'eval failed'}`);
    return out?.result?.value;
  }

  async function open() {
    if (alive() && ws) return;
    profileDir = mkdtempSync(join(tmpdir(), 'qqc-pvz-'));
    const bin = edge || findBrowser();
    if (!bin) throw new Error('找不到可用的浏览器（Edge/Chrome），没法开游戏');
    child = spawnImpl(bin, [
      '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions',
      `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
      '--window-size=1100,760', '--remote-allow-origins=*',
      `file:///${gameFile.replace(/\\/g, '/')}`,
    ], { stdio: 'ignore', windowsHide: true });
    child.on?.('exit', (code) => { if (!closing && code !== 0) log.warn?.(`游戏浏览器退出了（code ${code}）`); });

    // 等 DevTools 端口活过来，并且页面已经 load 完。
    const deadline = now() + openTimeoutMs;
    let target = null;
    while (now() < deadline) {
      try {
        const list = await httpJson('/json/list');
        target = list.find((t) => t.type === 'page' && /index\.html|^file:/.test(`${t.url}`)) || null;
        if (target?.webSocketDebuggerUrl) break;
      } catch { /* 端口还没起来，继续等 */ }
      await sleep(200);
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('游戏页面没起来（CDP 没找到目标）');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP 连接超时')), 10000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP 连接失败')); }, { once: true });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
      else p.resolve(msg.result);
    });
    await send('Runtime.enable');

    // 等游戏自己初始化完（页面脚本末尾会 init）。
    const readyBy = now() + 15000;
    while (now() < readyBy) {
      try { if ((await snapshot()).ready) return; } catch { /* 还没好 */ }
      await sleep(200);
    }
    throw new Error('游戏没初始化成功');
  }

  async function snapshot() {
    const raw = await evaluate(STATE_JS);
    try { return JSON.parse(raw); } catch { throw new Error('游戏状态读不出来'); }
  }

  /** 暂停 / 继续。真游戏暂停时跑计时器不动，她就有时间想。 */
  async function paused(on) {
    const want = on ? 'true' : 'false';
    await evaluate(`(() => {
      if (typeof gameState === 'undefined') return 'no-game';
      if (gameState.isPaused === ${want}) return 'ok';
      document.getElementById('pauseBtn').click();
      return 'toggled';
    })()`);
  }

  /** 替她收阳光：真人也是点一下，这只是手快。 */
  async function collect() {
    try {
      return await evaluate(`(() => {
        const suns = [...document.querySelectorAll('.sun')];
        suns.forEach((el) => el.click());
        return suns.length;
      })()`);
    } catch { return 0; }
  }

  /**
   * 种一格。返回 'ok' | 'no-card' | 'no-cell' | 'paused'。
   * 种没种上以调用方紧接着的 snapshot 为准——这里只保证「点到了」。
   */
  async function plant(type, row, col) {
    return evaluate(`(() => {
      if (typeof gameState === 'undefined') return 'no-game';
      if (gameState.isPaused) return 'paused';
      const card = [...document.querySelectorAll('.plantCard')].find((c) => c.dataset.plant === ${JSON.stringify(type)});
      const cell = document.querySelector('.cell[data-row="' + ${Number(row)} + '"][data-col="' + ${Number(col)} + '"]');
      if (!card) return 'no-card';
      if (!cell) return 'no-cell';
      card.click();
      cell.click();
      return 'ok';
    })()`);
  }

  async function close() {
    closing = true;
    try { ws?.close(); } catch { /* 已经断了 */ }
    ws = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('关闭')); }
    pending.clear();
    if (child) {
      try { child.kill(); } catch { /* 已经退了 */ }
      // Windows 上 Edge 会派生子进程：只 kill 父进程会留下浏览器。
      if (process.platform === 'win32') {
        try { spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 尽力 */ }
      }
      child = null;
    }
    if (profileDir) {
      try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* 删不掉就留着 */ }
      profileDir = '';
    }
  }

  return { open, close, snapshot, paused, collect, plant, evaluate, get port() { return port; } };
}
