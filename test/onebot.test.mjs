// OneBot 客户端：只测我们自己写的逻辑（连接、鉴权、重连退避、调用与错误）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneBot, sendText } from '../src/onebot.js';

function harness({ wsUrl = 'ws://127.0.0.1:3001/onebot/v11/ws', httpUrl = 'http://127.0.0.1:3001', token = 'T', wsToken = '' } = {}) {
  const events = [];
  const states = [];
  const timers = [];
  class FakeWS {
    constructor(url) { this.url = url; FakeWS.last = this; }
    close() { this.closed = true; this.onclose?.(); }
    open() { this.onopen?.(); }
    emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  }
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 99 } }) };
  };
  const ob = createOneBot({
    endpoint: () => ({ wsUrl, httpUrl, token, wsToken }),
    onEvent: (e) => events.push(e),
    onState: (s, d) => states.push([s, d]),
    WebSocketImpl: FakeWS,
    fetchImpl,
    timers: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} },
  });
  return { ob, FakeWS, events, states, calls, timers };
}

test('连接：带 access_token，open 后进入 connected', () => {
  const h = harness();
  h.ob.start();
  const ws = h.FakeWS.last;
  assert.match(ws.url, /access_token=T/);
  ws.open();
  assert.equal(h.ob.state, 'connected');
});

test('WS 有单独 token 时用它，不覆盖 HTTP 那个', () => {
  const h = harness({ wsToken: 'WSTOKEN' });
  h.ob.start();
  assert.match(h.FakeWS.last.url, /access_token=WSTOKEN/);
});

test('事件：post_type 的分派给 onEvent，其它丢弃', () => {
  const h = harness();
  h.ob.start();
  const ws = h.FakeWS.last;
  ws.open();
  ws.emit({ post_type: 'message', user_id: 1 });
  ws.emit({ echo: 'x' });
  assert.equal(h.events.length, 1);
});

test('断线：进入 reconnecting 并按退避重试', () => {
  const h = harness();
  h.ob.start();
  h.FakeWS.last.open();
  h.FakeWS.last.onclose();
  assert.equal(h.ob.state, 'reconnecting');
  assert.equal(h.timers[0].ms, 1000, '第一次退避 1 秒');
  h.timers[0].fn();
  assert.ok(h.FakeWS.last, '重试会新建连接');
});

test('主动 stop 不再重连', () => {
  const h = harness();
  h.ob.start();
  h.FakeWS.last.open();
  h.ob.stop();
  assert.equal(h.ob.state, 'stopped');
  assert.equal(h.timers.length, 0);
});

test('调用：POST 到 httpUrl/<action>，带 Bearer', async () => {
  const h = harness();
  const data = await h.ob.call('get_login_info', {});
  assert.equal(h.calls[0].url, 'http://127.0.0.1:3001/get_login_info');
  assert.equal(h.calls[0].init.headers.authorization, 'Bearer T');
  assert.deepEqual(JSON.parse(h.calls[0].init.body), {});
  assert.deepEqual(data, { message_id: 99 });
});

test('调用失败：retcode 非 0 抛带原因的错', async () => {
  const h = harness();
  h.calls.length = 0;
  const ob = createOneBot({
    endpoint: () => ({ wsUrl: '', httpUrl: 'http://x', token: '' }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'failed', retcode: 1400, wording: 'bad token' }) }),
    WebSocketImpl: class {},
  });
  await assert.rejects(() => ob.call('send_private_msg', {}), /bad token/);
});

test('sendText：私聊用 user_id，群聊用 group_id', async () => {
  const h = harness();
  await sendText(h.ob, { kind: 'private', userId: '42' }, '在');
  assert.equal(h.calls.at(-1).url, 'http://127.0.0.1:3001/send_private_msg');
  const body = JSON.parse(h.calls.at(-1).init.body);
  assert.equal(body.user_id, 42);
  assert.equal(body.message[0].data.text, '在');

  await sendText(h.ob, { kind: 'group', groupId: '9' }, '在');
  assert.equal(h.calls.at(-1).url, 'http://127.0.0.1:3001/send_group_msg');
  assert.equal(JSON.parse(h.calls.at(-1).init.body).group_id, 9);
});

test('没有 wsUrl：不崩，报错状态', () => {
  const h = harness({ wsUrl: '' });
  h.ob.start();
  assert.equal(h.ob.state, 'error');
});

test("网关参数：WS token 必须单独传下去（漏了就一直是 reconnecting）", async () => {
  const { endpointOf } = await import('../src/host.js');
  const ep = endpointOf({ onebot: { httpUrl: 'http://h', wsUrl: 'ws://w', token: 'HTTP', wsToken: 'WS' } });
  assert.equal(ep.token, 'HTTP');
  assert.equal(ep.wsToken, 'WS');
  assert.notEqual(ep.token, ep.wsToken, '两个 token 不能互相顶替');
});
