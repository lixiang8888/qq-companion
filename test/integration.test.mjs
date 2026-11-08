// 端到端（离线）：一条 QQ 私聊事件进来，经过陪伴体、假模型、拆条，真的落到 OneBot HTTP 上。
// 覆盖的是「协议形状」——真机最容易错的地方；WS 在 onebot.test 里已经单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.js';

const quiet = { warn() {}, info() {}, error() {} };

function fakeCtx(reply) {
  const seen = [];
  return {
    seen,
    llm: {
      listProviders: () => ['p'],
      listModels: async () => [{ id: 'm' }],
      async *stream(opts) {
        seen.push(opts);
        yield { type: 'text-delta', index: 0, text: reply };
        yield { type: 'finish', reason: { kind: 'done' } };
      },
    },
    webServer: { register: () => () => {} },
    effect: (fn) => { const off = fn(); return off; },
  };
}

async function fakeOneBot() {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ path: req.url, body: JSON.parse(body || '{}') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 } }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { received, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('私聊进来 → 拆成两条发回 QQ', async (t) => {
  let bot;
  try {
    bot = await fakeOneBot();
  } catch (e) {
    t.skip(`本机不允许监听回环端口：${e.message}`);
    return;
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-e2e-'));
  mkdirSync(join(dataDir, 'personas'), { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    ownerQQ: '42',
    onebot: { httpUrl: bot.url, wsUrl: '', token: 'T' },
    persona: '小鲸鱼',
  }));

  const ctx = fakeCtx('嗯嗯\n在呢');
  const host = createHost(ctx, { dataDir, now: () => 0, log: quiet, autoStart: false });
  await host.handleEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 42,
    message_id: 9,
    time: 1700000000,
    sender: { nickname: '小明' },
    message: [{ type: 'text', data: { text: '在吗' } }],
  });

  assert.equal(bot.received.length, 2, `应发两条，实际 ${bot.received.length}`);
  assert.match(bot.received[0].path, /send_private_msg/);
  assert.equal(bot.received[0].body.user_id, 42);
  assert.equal(bot.received[0].body.message[0].data.text, '嗯嗯');
  assert.equal(bot.received[1].body.message[0].data.text, '在呢');

  // 模型真的收到「人」了吗：人格卡、情绪块、消息形状三样一起断。
  const sent = ctx.seen[0];
  const sys = sent.messages[0];
  assert.equal(sys.role, 'system');
  assert.equal(sys.source.kind, 'system-prompt');
  assert.match(sys.content[0].text, /小鲸鱼/, '人格卡必须进 prompt');
  assert.doesNotMatch(sys.content[0].text, /=>/, '人格被当成函数源码发过去 = 静默失效');
  assert.match(sys.content[0].text, /不要说出口/, '情绪注入块必须进 prompt');
  assert.equal(sent.messages[1].role, 'user');
  // 正文前面带一个时间戳（「（今天 21:04）在吗」）——她得知道这句话是什么时候说的。
  assert.equal(sent.messages[1].content[0].text.replace(/^（[^）]*）/, ''), '在吗');
  assert.match(sent.messages[1].content[0].text, /^（.+ \d{2}:\d{2}）在吗$/);

  await bot.close();
});

test('重启之后：会话还在，接着聊', async (t) => {
  let bot;
  try {
    bot = await fakeOneBot();
  } catch (e) {
    t.skip(`本机不允许监听回环端口：${e.message}`);
    return;
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-e2e-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ enabled: true, ownerQQ: '42', onebot: { httpUrl: bot.url, wsUrl: '', token: '' } }));

  const host1 = createHost(fakeCtx('在呢'), { dataDir, now: () => 0, log: quiet, autoStart: false, sleep: async () => {} });
  await host1.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, message: [{ type: 'text', data: { text: '记住我喜欢猫' } }] });
  assert.equal(host1.session.size, 2);

  const host2 = createHost(fakeCtx('嗯'), { dataDir, now: () => 0, log: quiet, autoStart: false, sleep: async () => {} });
  assert.equal(host2.session.size, 2, '重启后上下文应该还在');
  assert.match(host2.memory.block({ text: '还记得吗', userId: '42' }) && 'ok', /ok/);
  await bot.close();
});

test('重启之后：会话还在，接着聊', async (t) => {
  let bot;
  try {
    bot = await fakeOneBot();
  } catch (e) {
    t.skip(`本机不允许监听回环端口：${e.message}`);
    return;
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-e2e-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ enabled: true, ownerQQ: '42', onebot: { httpUrl: bot.url, wsUrl: '', token: '' } }));

  const host1 = createHost(fakeCtx('在呢'), { dataDir, now: () => 0, log: quiet, autoStart: false, sleep: async () => {} });
  await host1.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, message: [{ type: 'text', data: { text: '记住我喜欢猫' } }] });
  assert.equal(host1.session.size, 2);

  const host2 = createHost(fakeCtx('嗯'), { dataDir, now: () => 0, log: quiet, autoStart: false, sleep: async () => {} });
  assert.equal(host2.session.size, 2, '重启后上下文应该还在');
  await bot.close();
});

test('并发：两条消息前后脚到，不会互相吃掉', async (t) => {
  let bot;
  try {
    bot = await fakeOneBot();
  } catch (e) {
    t.skip(`本机不允许监听回环端口：${e.message}`);
    return;
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-e2e-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ enabled: true, ownerQQ: '42', onebot: { httpUrl: bot.url, wsUrl: '', token: '' } }));

  // 慢模型：让两次处理有机会交错
  const slow = fakeCtx('嗯');
  const original = slow.llm.stream.bind(slow.llm);
  slow.llm.stream = async function* (...args) {
    await new Promise((r) => setTimeout(r, 5));
    yield* original(...args);
  };

  const host = createHost(slow, { dataDir, now: () => 0, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0 });
  const ev = (text) => ({ post_type: 'message', message_type: 'private', user_id: 42, message: [{ type: 'text', data: { text } }] });
  await Promise.all([host.handleEvent(ev('我养了猫叫团子')), host.handleEvent(ev('今天加班到十点'))]);

  assert.equal(host.memory.card().records.length, 2, '两条记忆都要在');
  assert.equal(host.session.size, 4, '两轮对话都要在');
  assert.equal(bot.received.length, 2, '两轮都要发出去');
  const roles = host.session.snapshot().history.map((m) => m.role).join(',');
  assert.equal(roles, 'user,assistant,user,assistant', `顺序被打乱了：${roles}`);
  await bot.close();
});

test('超长消息：截断后照常回，不把这一轮弄丢', async (t) => {
  let bot;
  try {
    bot = await fakeOneBot();
  } catch (e) {
    t.skip(`本机不允许监听回环端口：${e.message}`);
    return;
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-e2e-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ enabled: true, ownerQQ: '42', onebot: { httpUrl: bot.url, wsUrl: '', token: '' } }));
  const ctx = fakeCtx('嗯');
  const host = createHost(ctx, { dataDir, now: () => 0, log: quiet, autoStart: false, sleep: async () => {} });

  await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, message: [{ type: 'text', data: { text: '啊'.repeat(6000) } }] });
  assert.equal(bot.received.length, 1, '超长消息也要有回复');
  const user = ctx.seen[0].messages[1].content[0].text;
  assert.ok(user.length < 4200, `截断失效，长度 ${user.length}`);
  assert.match(user, /没看完/);
  await bot.close();
});

test('陌生人：不发任何请求', async (t) => {
  let bot;
  try {
    bot = await fakeOneBot();
  } catch (e) {
    t.skip(`本机不允许监听回环端口：${e.message}`);
    return;
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-e2e-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ enabled: true, ownerQQ: '42', onebot: { httpUrl: bot.url, wsUrl: '', token: '' } }));
  const host = createHost(fakeCtx('嗯'), { dataDir, now: () => 0, log: quiet, autoStart: false });
  const r = await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 999, message: [{ type: 'text', data: { text: '你好' } }] });
  assert.deepEqual(r, { ignored: 'not-owner' });
  assert.equal(bot.received.length, 0);
  await bot.close();
});
