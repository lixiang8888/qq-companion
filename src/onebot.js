// OneBot v11 客户端：WS 收事件，HTTP 调接口。
//
// 为什么不自己撸重连逻辑在 host 里：私聊陪伴要能连一整天，断线重连、退避、登录号核对
// 是唯一必须做对的基础设施。所有依赖（WebSocket / fetch / 定时器）都可注入，方便离线测。

import { existsSync, readFileSync } from 'node:fs';

const DEFAULTS = { timeoutMs: 15000, backoffMin: 1000, backoffMax: 30000 };

export function createOneBot({
  endpoint,                       // () => ({ httpUrl, wsUrl, token })
  log = () => {},
  onEvent = () => {},
  onState = () => {},
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  timers = { setTimeout, clearTimeout },
}) {
  let ws = null;
  let timer = null;
  let attempt = 0;
  let state = 'stopped';
  let closedByUs = false;

  function setState(next, detail = '') {
    state = next;
    onState(next, detail);
    if (detail) log(`网关 ${next}：${detail}`);
  }

  function wsUrlOf(ep) {
    if (!ep.wsUrl) return '';
    // SnowLuma 的 HTTP 和 WS 可以是两个不同的 token，所以 WS 单独给一个字段，没填才回落到总 token。
    const token = ep.wsToken || ep.token;
    if (!token) return ep.wsUrl;
    const u = new URL(ep.wsUrl);
    u.searchParams.set('access_token', token);
    return u.toString();
  }

  function connect() {
    const ep = endpoint();
    const url = wsUrlOf(ep);
    if (!url) return setState('error', '没有配置 OneBot WebSocket 地址');
    if (typeof WebSocketImpl !== 'function') return setState('error', '当前运行环境没有 WebSocket');
    closedByUs = false;
    setState('connecting', url.replace(/access_token=[^&]+/, 'access_token=***'));
    try {
      ws = new WebSocketImpl(url);
    } catch (error) {
      return scheduleRetry(`建立连接失败：${error.message}`);
    }
    ws.onopen = () => {
      attempt = 0;
      setState('connected');
    };
    ws.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return log('收到无法解析的事件，已忽略');
      }
      if (data?.post_type) onEvent(data);
      else if (data?.echo) log(`未匹配的响应 echo=${data.echo}`);
    };
    ws.onerror = () => { /* onclose 会紧跟着来，这里不重复报 */ };
    ws.onclose = () => {
      ws = null;
      if (closedByUs) return setState('stopped');
      scheduleRetry('连接断开');
    };
  }

  function scheduleRetry(reason) {
    attempt += 1;
    const delay = Math.min(DEFAULTS.backoffMax, DEFAULTS.backoffMin * 2 ** (attempt - 1));
    setState('reconnecting', `${reason}（${Math.round(delay / 1000)}s 后重试）`);
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      if (state !== 'stopped') connect();
    }, delay);
  }

  async function call(action, params = {}, { timeoutMs = DEFAULTS.timeoutMs } = {}) {
    const ep = endpoint();
    if (!ep.httpUrl) throw new Error('没有配置 OneBot HTTP 地址');
    const res = await fetchImpl(`${ep.httpUrl.replace(/\/$/, '')}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ep.token ? { authorization: `Bearer ${ep.token}` } : {}),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${action} 失败：HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    if (!body) throw new Error(`${action} 失败：返回不是 JSON`);
    if (body.status === 'failed' || (body.retcode !== 0 && body.retcode !== undefined)) {
      const why = body.wording || body.message || `retcode=${body.retcode}`;
      throw new Error(`${action} 失败：${why}`);
    }
    return body.data ?? null;
  }

  function stop() {
    closedByUs = true;
    timers.clearTimeout(timer);
    timer = null;
    try { ws?.close?.(); } catch { /* 已经关了 */ }
    ws = null;
    setState('stopped');
  }

  function restart() {
    stop();
    closedByUs = false;
    connect();
  }

  return {
    start: () => { if (state === 'stopped') connect(); },
    stop,
    restart,
    call,
    get state() { return state; },
  };
}

/** 按会话发一条文本。群聊要 group_id，私聊要 user_id。 */
export function sendText(onebot, msg, text) {
  const isGroup = msg.kind === 'group';
  return onebot.call(isGroup ? 'send_group_msg' : 'send_private_msg', {
    ...(isGroup ? { group_id: Number(msg.groupId) } : { user_id: Number(msg.userId) }),
    message: [{ type: 'text', data: { text: String(text) } }],
  });
}

// 发出去的图别超过这个：base64 之后还要再涨三分之一，整包 JSON 太大会被网关或 QQ 拒。
export const MAX_SEND_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * 一张图变成一个 image 段。
 *
 * OneBot v11 三种来源都收：http(s) 地址、本地路径、base64。这里统一成一种能用的：
 *   · 已经是 url / base64:// → 原样给（网关自己去取，省一次读盘和一次编码）
 *   · 本地路径或 Buffer → base64://（QQ 的图床地址会过期，本地路径又要求网关和我们同一台机器）
 * 认不出来就抛：宁可这一句不发，也不要发一个注定失败的空请求。
 */
export function imageSegment(file) {
  if (Buffer.isBuffer(file)) {
    if (!file.length) throw new Error('发图：空的');
    if (file.length > MAX_SEND_IMAGE_BYTES) throw new Error(`发图：太大（${Math.round(file.length / 1024 / 1024)}MB）`);
    return { type: 'image', data: { file: `base64://${file.toString('base64')}` } };
  }
  const s = String(file ?? '').trim();
  if (!s) throw new Error('发图：没给图');
  if (/^(https?:|base64:\/\/|file:\/\/)/i.test(s)) return { type: 'image', data: { file: s } };
  if (existsSync(s)) {
    const bytes = readFileSync(s);
    if (bytes.length > MAX_SEND_IMAGE_BYTES) throw new Error(`发图：太大（${Math.round(bytes.length / 1024 / 1024)}MB）`);
    return { type: 'image', data: { file: `base64://${bytes.toString('base64')}` } };
  }
  throw new Error(`发图：找不到这个东西（${s.slice(0, 60)}）`);
}

/** 按会话发一张图。表情包也是一张图——OneBot 没有「发表情」这个 action。 */
export function sendImage(onebot, msg, file) {
  const isGroup = msg.kind === 'group';
  return onebot.call(isGroup ? 'send_group_msg' : 'send_private_msg', {
    ...(isGroup ? { group_id: Number(msg.groupId) } : { user_id: Number(msg.userId) }),
    message: [imageSegment(file)],
  });
}
