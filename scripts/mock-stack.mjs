// 验证用的假 OneBot + 假模型。不参与插件运行，只在「真机装载自测」里用。
//
//   node scripts/mock-stack.mjs        （端口和输出文件用环境变量改，见下）
//
// 三件事：
//   1. 在 MODEL_PORT 上假装 DeepSeek 的 Messages API（/v1/messages，SSE），回一句「在呢」；
//   2. 在 HTTP_PORT 上假装 OneBot 的 HTTP 接口，把插件发来的私聊回复记进日志；
//   3. 在 WS_PORT 上假装 OneBot 的 WebSocket，客户端连上后推一条私聊事件。
//
// 为什么手写 WebSocket 握手：插件侧是标准 OneBot 11 正向 WS，而这里不能装依赖。

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';

const OUT = process.env.MOCK_OUT || 'mock-stack.log';
const MODEL_PORT = Number(process.env.MOCK_MODEL_PORT || 18080);
const WS_PORT = Number(process.env.MOCK_WS_PORT || 13001);
const HTTP_PORT = Number(process.env.MOCK_HTTP_PORT || 13000);
const REPLY = process.env.MOCK_REPLY || '在呢';
const PUSH_AFTER_MS = Number(process.env.MOCK_PUSH_AFTER || 1500);
const TURNS = Number(process.env.MOCK_TURNS || 1);         // 推几条，>30 会触发会话压缩
const INTERVAL_MS = Number(process.env.MOCK_INTERVAL || 4000);

writeFileSync(OUT, '');
const log = (m) => appendFileSync(OUT, `${new Date().toISOString().slice(11, 23)} ${m}\n`);

// ---- 假模型：Anthropic Messages 流式协议的最小合法序列 ----
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    log(`model ${req.method} ${req.url} key=${Boolean(req.headers['x-api-key'] || req.headers.authorization)}`);
    if (req.method !== 'POST') { res.statusCode = 404; res.end('{}'); return; }
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* 记日志就够 */ }
    const sys = typeof parsed.system === 'string' ? parsed.system : JSON.stringify(parsed.system || '');
    log(`model messages=${(parsed.messages || []).length} system=${Boolean(sys)} summary=${sys.includes('摘要')} persona=${sys.includes('大肥鱼')} model=${parsed.model}`);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse(res, 'message_start', {
      type: 'message_start',
      message: { id: 'msg_mock', type: 'message', role: 'assistant', model: parsed.model || 'mock', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } },
    });
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });
}).listen(MODEL_PORT, '127.0.0.1', () => log(`model listening ${MODEL_PORT}`));

// ---- 假 OneBot HTTP：插件发消息打到这里 ----
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    log(`onebot http ${req.method} ${req.url} body=${body.slice(0, 200)}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 } }));
  });
}).listen(HTTP_PORT, '127.0.0.1', () => log(`onebot http listening ${HTTP_PORT}`));

// ---- 假 OneBot WS：握手后推一条私聊 ----
function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const head = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

createServer((req, res) => { res.statusCode = 426; res.end('upgrade required'); })
  .on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] || '';
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));
    log(`onebot ws connected ${req.url}`);
    socket.on('data', (b) => log(`onebot ws client sent ${b.length} bytes`));
    socket.on('error', (e) => log(`onebot ws error ${e.message}`));
    const send = (text, id) => socket.write(frame(JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      self_id: 10000,
      user_id: 42,
      message_id: id,
      raw_message: text,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: 42, nickname: '小明' },
      message: [{ type: 'text', data: { text } }],
    })));

    setTimeout(() => { send('在吗', 1); log('onebot ws pushed 在吗'); }, PUSH_AFTER_MS);
    // 默认第二句是为了验 assistant 消息的形状：真适配器会读 source.kind / source.replayState。
    // 设 MOCK_TURNS=35 会连着推很多句，用来在真宿主里触发会话压缩。
    for (let i = 2; i <= TURNS; i++) {
      setTimeout(() => { send(`第 ${i} 句：今天还是老样子`, i); log(`onebot ws pushed ${i}`); }, PUSH_AFTER_MS + (i - 1) * INTERVAL_MS);
    }
  })
  .listen(WS_PORT, '127.0.0.1', () => log(`onebot ws listening ${WS_PORT}`));

process.on('SIGINT', () => process.exit(0));
