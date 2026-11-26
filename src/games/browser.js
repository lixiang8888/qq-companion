// 无头浏览器 + 本地静态服务：她所有"真游戏"的公共底座。
//
// 为什么走 http 而不是 file://：localStorage、相对路径、字体、以后的动态加载都跟真页面一致；
// file:// 下 Chrome 对 localStorage 的行为不可靠（游戏存档会直接抛）。服务只绑 127.0.0.1，
// 只读 assets/games 这一棵树。
//
// 依赖：Node 自带的全局 WebSocket + 本机 Edge/Chrome，没有新依赖。

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';

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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起一个只读静态服务，根目录之外一律 404。
 * 只给本地无头浏览器用；不要拿来对外。
 */
export async function startStaticServer({
  root,
  host = '127.0.0.1',
  port = 0,
  read = readFileSync,
  isFile = (p) => statSync(p).isFile(),
} = {}) {
  if (!root) throw new Error('静态服务缺根目录');
  // resolve 去掉尾部斜杠：带 `\` 的根会让 startsWith 判不过，所有请求都 404（真机踩过）。
  const base = resolve(root);
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let path;
    try { path = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
    if (path === '/' || path === '') path = '/index.html';
    const file = normalize(join(base, path));
    if (!file.startsWith(base + sep)) { res.writeHead(404); res.end('not found'); return; }
    let body;
    try {
      if (!isFile(file)) { res.writeHead(404); res.end('not found'); return; }
      body = read(file);
    } catch { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  const actual = server.address().port;
  return {
    port: actual,
    url: `http://${host}:${actual}`,
    close: () => new Promise((resolve) => {
      try { server.closeAllConnections?.(); } catch { /* 老 Node */ }
      server.close(() => resolve(undefined));
    }),
  };
}

/** 键盘名 → CDP 需要的三件套（key / code / windowsVirtualKeyCode）。 */
const KEYS = {
  ArrowUp: ['ArrowUp', 'ArrowUp', 38],
  ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 'ArrowRight', 39],
  Enter: ['Enter', 'Enter', 13],
  Space: [' ', 'Space', 32],
  Escape: ['Escape', 'Escape', 27],
  Tab: ['Tab', 'Tab', 9],
};
for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
  const upper = ch.toUpperCase();
  KEYS[upper] = [ch, `Key${upper}`, upper.charCodeAt(0)];
}
for (const ch of '0123456789') KEYS[ch] = [ch, `Digit${ch}`, ch.charCodeAt(0)];

export function keySpec(name) {
  const hit = KEYS[String(name || '')];
  if (!hit) return null;
  return { key: hit[0], code: hit[1], vk: hit[2] };
}

/**
 * 开一个无头浏览器。open() 起浏览器并打开页面；close() 一定要调。
 * 所有失败都抛出来，由 host 记日志：她这一次不玩，但下一次还能玩。
 */
export function createBrowser({
  bin = '',
  root,
  log = console,
  spawnImpl = spawn,
  now = Date.now,
  sleep = sleepDefault,
  port = 9300 + (process.pid % 80),
  viewport = { width: 1280, height: 800 },
  openTimeoutMs = 25000,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  let child = null;
  let profileDir = '';
  let ws = null;
  let seq = 0;
  let closing = false;
  let server = null;
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
    if (out?.exceptionDetails) throw new Error(`页面报错：${out.exceptionDetails.exception?.description || out.exceptionDetails.text || 'eval failed'}`);
    return out?.result?.value;
  }

  async function ensureServer() {
    if (server) return server;
    server = await startStaticServer({ root });
    return server;
  }

  async function waitReady(readyExpr) {
    const deadline = now() + openTimeoutMs;
    while (now() < deadline) {
      try {
        const state = await evaluate('document.readyState');
        const ok = state === 'complete' && (!readyExpr || await evaluate(`Boolean(${readyExpr})`));
        if (ok) return;
      } catch { /* 页面还在导航 / 尚未就绪 */ }
      await sleep(200);
    }
    throw new Error('页面没就绪');
  }

  async function navigate(url, readyExpr = '') {
    await send('Page.navigate', { url });
    await waitReady(readyExpr);
    try { await send('Page.bringToFront'); } catch { /* 无头模式下偶尔不支持，不影响读状态 */ }
  }

  async function open(entry = '', { ready = '' } = {}) {
    const srv = await ensureServer();
    const url = `${srv.url}/${String(entry || 'index.html').replace(/^\/+/, '')}`;
    if (alive() && ws) { await navigate(url, ready); return; }
    profileDir = mkdtempSync(join(tmpdir(), 'qqc-game-'));
    const exe = bin || findBrowser();
    if (!exe) throw new Error('找不到可用的浏览器（Edge/Chrome），没法开游戏');
    child = spawnImpl(exe, [
      '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--force-device-scale-factor=1',
      `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
      `--window-size=${viewport.width},${viewport.height}`, '--remote-allow-origins=*',
      url,
    ], { stdio: 'ignore', windowsHide: true });
    child.on?.('exit', (code) => { if (!closing && code !== 0) log.warn?.(`游戏浏览器退出了（code ${code}）`); });

    // 等 DevTools 端口活过来。
    const deadline = now() + openTimeoutMs;
    let target = null;
    while (now() < deadline) {
      try {
        const list = await httpJson('/json/list');
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && String(t.url).startsWith(srv.url)) || null;
        if (target) break;
      } catch { /* 端口还没起来，继续等 */ }
      await sleep(200);
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('游戏页面没起来（CDP 没找到目标）');

    ws = new WebSocketImpl(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP 连接超时')), 10000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(undefined); }, { once: true });
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
    await send('Page.enable');
    await waitReady(ready);
    // 刚导航完的页面偶尔收不到输入（无头 Edge 上冒烟见过按键丢）——先把目标提到前台。
    try { await send('Page.bringToFront'); } catch { /* 不支持就算了 */ }
  }

  /** 截当前视口，返回 data URL（给看图模型）和尺寸（给点坐标换算）。 */
  async function screenshot({ quality = 70 } = {}) {
    const out = await send('Page.captureScreenshot', { format: 'jpeg', quality });
    const data = String(out?.data || '');
    return { data, dataUrl: `data:image/jpeg;base64,${data}`, width: viewport.width, height: viewport.height };
  }

  /** 在页面坐标（CSS px，左上角 0,0）点一下。 */
  async function click(x, y) {
    const cx = Math.max(0, Math.min(viewport.width - 1, Number(x) || 0));
    const cy = Math.max(0, Math.min(viewport.height - 1, Number(y) || 0));
    const base = { x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  }

  /** 按一下键（键盘游戏用）。 */
  async function key(name, { holdMs = 0 } = {}) {
    const spec = keySpec(name);
    if (!spec) throw new Error(`不认识的键：${name}`);
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    if (holdMs > 0) await sleep(holdMs);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async function close() {
    closing = true;
    try { ws?.close(); } catch { /* 已经断了 */ }
    ws = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('关闭')); }
    pending.clear();
    if (child) {
      try { child.kill(); } catch { /* 已经退了 */ }
      if (process.platform === 'win32') {
        try { spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 尽力 */ }
      }
      child = null;
    }
    await sleep(200);
    if (server) { try { await server.close(); } catch { /* 关不掉就算了 */ } server = null; }
    if (profileDir) {
      const dir = profileDir;
      profileDir = '';
      for (let i = 0; i < 5; i += 1) {
        try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(200); }
      }
    }
  }

  return { open, close, navigate, evaluate, screenshot, click, key, get port() { return port; } };
}
