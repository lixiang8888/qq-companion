// 插件入口：注入面、路由、以及不碰网络的那几条路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.js';
import { appendTranscript } from '../src/transcript.js';
import { apply } from '../src/host.js';
import { initState } from '../src/affect/core.js';
import { createCard, remember } from '../src/memory/card.js';
import { renderPanel } from '../src/panel.js';

const quiet = { warn() {}, info() {}, error() {} };

function fakeCtx({ providers = ['deepseek-official'], models = [{ id: 'deepseek-flash' }], reply = '嗯', replies = null } = {}) {
  const routes = [];
  const effects = [];
  const vars = {};
  const calls = [];
  return {
    routes, effects, vars, calls,
    llm: {
      listProviders: () => providers,
      listModels: async () => models,
      async *stream(opts) {
        calls.push(opts);
        const text = replies ? (replies[calls.length - 1] ?? '') : reply;
        yield { type: 'text-delta', index: 0, text };
        // usage 在协议里紧挨着 finish，她的账全靠这一块。
        yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0 } };
        yield { type: 'finish', reason: { kind: 'done' } };
      },
    },
    systemPrompt: { variable: (n, fn) => { vars[n] = fn; return () => {}; } },
    webServer: { register: (d) => { routes.push(d); return () => {}; } },
    effect: (fn, label) => { effects.push(label); const off = fn(); return off; },
  };
}

const setup = (opts) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-host-'));
  const ctx = fakeCtx(opts);
  const host = createHost(ctx, { dataDir, now: () => 0, log: quiet, autoStart: false });
  return { ctx, host, dataDir };
};

test('主动搭话：默认关闭，不会偷偷调用模型', async () => {
  const { host, ctx } = setup();
  let calls = 0;
  const original = ctx.llm.stream.bind(ctx.llm);
  ctx.llm.stream = (...args) => { calls += 1; return original(...args); };
  const r = await host.proactive.tick();
  assert.deepEqual(r, { poked: false, reason: '未开启' });
  assert.equal(calls, 0);
});

test('主动搭话：期待到了就自己想一次，发出去的那句她才记得', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-poke-'));
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: init?.body });
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
  };
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    ownerQQ: '42',
    onebot: { httpUrl: 'http://127.0.0.1:9' },
    // quietFrom === quietTo 表示没有安静时段，免得这条测试跟着跑在一个半夜的钟点上翻车。
    proactive: { enabled: true, minIdleMinutes: 180, quietFrom: 0, quietTo: 0 },
  }));
  let clock = new Date(2026, 0, 1, 9, 0, 0).getTime();
  const ctx = fakeCtx({ replies: ['嗯', '{"send":true,"message":"在干嘛"}', '{"send":false,"waitMinutes":45}'] });
  const host = createHost(ctx, { dataDir, now: () => clock, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0, fetchImpl });

  // 聊一轮：她最后说话。以前到这个状态，那个「上一条是我说的」闸门就永远关着。
  // time 要显式给：没给的话会落到真实时钟上，和这条测试的假时钟对不上。
  await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: '早', time: Math.floor(clock / 1000) });

  const early = await host.proactive.tick();
  assert.equal(early.poked, false, '刚聊完不该马上又找他');
  assert.match(early.reason, /期待/);

  clock += 4 * 3600e3; // 四个小时后他还没吭声
  const r = await host.proactive.tick();
  assert.equal(r.poked, true);
  assert.equal(r.sent, 1);
  assert.ok(sent.some((s) => s.url.endsWith('/send_private_msg')), '真的发出去了');

  const history = host.session.snapshot().history;
  assert.ok(history.some((m) => m.role === 'assistant' && m.text === r.message), '她确实说过这句，得记得');
  assert.ok(!history.some((m) => /这是你自己在想/.test(m.text)), '「想」的过程不能住进她的记忆');

  // 连发一次之后期待点翻倍 + 冷却：不会四小时后立刻又来一条。
  const again = await host.proactive.tick();
  assert.equal(again.poked, false);
});

test('面板操作：忘记一条、置顶一条、再找回', async () => {
  const { ctx, host } = setup();
  await host.memory.block({ text: '他喜欢猫', userId: '42' });
  await host.memory.block({ text: '他讨厌香菜', userId: '42' });
  const [a, b] = host.memory.card().records;
  const panel = ctx.routes.find((r) => r.path.endsWith('/panel'));
  const call = async (url) => { let out = ''; await panel.handler({ url }, { setHeader() {}, end: (s) => { out = s; } }); return out; };
  const live = () => host.memory.card().records.filter((r) => r.forgottenAt === undefined);

  await call(`/qq-companion/api/panel?forget=${a.id}`);
  assert.equal(live().length, 1, '忘记之后不再算记得');
  assert.equal(host.memory.card().records.length, 2, '但记录还在（可找回）');

  const html = await call('/qq-companion/api/panel');
  assert.match(html, /找回/, '面板上要给出找回入口');

  await call(`/qq-companion/api/panel?restore=${a.id}`);
  assert.equal(live().length, 2, '找回之后又记起来了');

  await call(`/qq-companion/api/panel?pin=${b.id}`);
  assert.equal(live().find((r) => r.id === b.id).pinned, true);
});

test('面板操作：跨站请求一律拒绝（写操作挂在 GET 上）', async () => {
  const { ctx, host } = setup();
  await host.memory.block({ text: '他喜欢猫', userId: '42' });
  const [a] = host.memory.card().records;
  const panel = ctx.routes.find((r) => r.path.endsWith('/panel'));
  let out = '';
  await panel.handler(
    { url: `/qq-companion/api/panel?forget=${a.id}`, headers: { 'sec-fetch-site': 'cross-site' } },
    { setHeader() {}, end: (s) => { out = s; } },
  );
  assert.match(out, /跨站请求被拒绝/);
  assert.equal(host.memory.card().records.length, 1, '跨站请求不能让她忘事');
});

test('没有可用 provider：报错要说人话，不能只给 NO_ADAPTER', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-host-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
  const host = createHost(fakeCtx({ providers: [] }), { dataDir, now: () => 0, log: quiet, autoStart: false });
  await assert.rejects(
    () => host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, message: [{ type: 'text', data: { text: '在吗' } }] }),
    /没有可用的模型 provider/,
  );
});

test('启动诊断：没配主人时就明说「她谁都不回」，并给出面板地址', () => {
  const logs = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-host-'));
  createHost(fakeCtx(), {
    dataDir,
    autoStart: false,
    log: { warn: (m) => logs.push(m), info: (m) => logs.push(m), error: () => {} },
  });
  assert.ok(logs.some((m) => /ownerQQ/.test(m) && /不回/.test(m)), logs.join(' | '));
  assert.ok(logs.some((m) => /\/qq-companion\/api\/panel/.test(m)), logs.join(' | '));
});

test('真 DSH 形状：provider/model 是对象时也要取到 id（否则第一句就 NO_ADAPTER）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-host-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    ownerQQ: '42',
    onebot: { httpUrl: 'http://127.0.0.1:1', wsUrl: '', token: '' },
  }));
  const seen = [];
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      async *stream(opts) {
        seen.push(opts);
        yield { type: 'finish', reason: { kind: 'done' } };
      },
    },
    effect: (fn) => fn(),
    webServer: { register: () => () => {} },
  };
  const host = createHost(ctx, { dataDir, now: () => 0, log: quiet, autoStart: false, sleep: async () => {} });
  await host.handleEvent({
    post_type: 'message', message_type: 'private', user_id: 42, message: [{ type: 'text', data: { text: '在吗' } }],
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].provider, 'deepseek-official');
  assert.equal(seen[0].model, 'deepseek-v4-flash');
});

// cordis 的服务是代理：没写进 inject 的服务名一旦被点出来就抛。
// 这条测试钉住「可选服务必须走 ctx.get()」，否则 createHost 会从那一行开始静默中断。
test('cordis 风格上下文：读取未注入的服务会抛，插件也必须活下来', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-host-'));
  const ctx = {
    llm: { listProviders: () => ['p'], listModels: async () => [{ id: 'm' }], async *stream() {} },
    effect: (fn) => fn(),
    get: () => undefined,
  };
  Object.defineProperty(ctx, 'webServer', {
    get() { throw new Error('cannot get property "webServer" without inject'); },
  });
  const host = createHost(ctx, { dataDir, now: () => 0, log: quiet, autoStart: false });
  assert.ok(host.companion, '不能因为少一个可选服务就整个插件不启动');
});

function formRequest(fields, headers = {}) {
  const raw = new URLSearchParams(fields).toString();
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    on: (ev, cb) => { if (ev === 'data') cb(raw); if (ev === 'end') setTimeout(cb, 0); },
  };
}

test('记忆块：传进来的心情会跟着这条记忆存下来', async () => {
  const { host } = setup();
  await host.memory.block({ text: '我妈住院了', userId: '42' }, { mood: { v: 0.2, a: 0.6 } });
  const rec = host.memory.card().records[0];
  assert.deepEqual(rec.feel, { v: 0.2, a: 0.6 });
  const block = await host.memory.block({ text: '今天吃面', userId: '42' }, { mood: { v: 0.5, a: 0.3 } });
  assert.match(block, /那会儿我挺难受/, '下一轮回忆里要带出当时的感受');
});

test('真 DSH 形状：provider/model 是对象时也要取到 id（否则第一句就 NO_ADAPTER）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-host-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    ownerQQ: '42',
    onebot: { httpUrl: 'http://127.0.0.1:1', wsUrl: '', token: '' },
  }));
  const seen = [];
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      async *stream(opts) { seen.push(opts); yield { type: 'finish', reason: { kind: 'done' } }; },
    },
    effect: (fn) => fn(),
    webServer: { register: () => () => {} },
  };
  const host = createHost(ctx, { dataDir, now: () => 0, log: quiet, autoStart: false, sleep: async () => {} });
  await host.handleEvent({
    post_type: 'message', message_type: 'private', user_id: 42, message: [{ type: 'text', data: { text: '在吗' } }],
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].provider, 'deepseek-official');
  assert.equal(seen[0].model, 'deepseek-v4-flash');
});

test('空消息：不叫模型、不写记忆', async () => {
  const { ctx, host, dataDir } = setup();
  let calls = 0;
  const original = ctx.llm.stream.bind(ctx.llm);
  ctx.llm.stream = (...args) => { calls += 1; return original(...args); };
  const r = await host.handleEvent({
    post_type: 'message', message_type: 'private', user_id: 42, message: [],
  });
  assert.deepEqual(r, { ignored: 'empty' });
  assert.equal(calls, 0);
  assert.equal(host.memory.card().records.length, 0);
  assert.ok(dataDir);
});

test('面板能改配置：表单保存后落盘，留空的 token 不被冲掉', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-host-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    ownerQQ: '42', onebot: { wsUrl: 'ws://old', httpUrl: 'http://old', token: 'SECRET' },
  }));
  const ctx = fakeCtx();
  const host = createHost(ctx, { dataDir, now: () => 0, log: quiet, autoStart: false });
  // 改了 wsUrl 会真去重连，测试里把这步换掉，否则网关一直重试、进程不退。
  let restarted = 0;
  host.onebot.restart = () => { restarted += 1; };
  const route = ctx.routes.find((r) => r.path.endsWith('/config'));

  let out = '';
  let type = '';
  await route.handler(
    formRequest({ ownerQQ: '10001', wsUrl: 'ws://127.0.0.1:3999', httpUrl: 'http://127.0.0.1:3998', token: '', persona: '小鲸鱼' }),
    { setHeader: (k, v) => { if (k === 'content-type') type = v; }, end: (s) => { out = s; } },
  );
  assert.match(type, /text\/html/, '表单提交要回人话，不是 JSON');
  assert.match(out, /已保存/);
  assert.equal(host.config.ownerQQ, '10001');
  assert.equal(host.config.onebot.wsUrl, 'ws://127.0.0.1:3999');
  assert.equal(host.config.onebot.token, 'SECRET', '留空表示不改 token');
  assert.equal(restarted, 1, '连接参数变了应该重连');
});

test('改配置也挡跨站：别的网站不能改她的主人', async () => {
  const { ctx, host } = setup();
  const route = ctx.routes.find((r) => r.path.endsWith('/config'));
  let out = '';
  await route.handler(
    formRequest({ ownerQQ: '666' }, { 'sec-fetch-site': 'cross-site' }),
    { setHeader() {}, end: (s) => { out = s; } },
  );
  assert.match(out, /跨站请求被拒绝/);
  assert.notEqual(host.config.ownerQQ, '666');
});

test('面板里真的有设置表单，带着当前值', async () => {
  const { ctx } = setup();
  const panel = ctx.routes.find((r) => r.path.endsWith('/panel'));
  let out = '';
  await panel.handler({ url: '/qq-companion/api/panel' }, { setHeader() {}, end: (s) => { out = s; } });
  assert.match(out, /name="ownerQQ"/);
  assert.match(out, /name="wsUrl"/);
  assert.match(out, /<form method="post" action="config">/);
});

test('默认人格卡：还是那只大肥鱼，雷点与去 AI 味都在', () => {
  const { dataDir } = setup();
  const text = readFileSync(join(dataDir, 'personas', '小鲸鱼.md'), 'utf8');
  assert.match(text, /小鲸鱼/);
  assert.match(text, /大肥鱼/, '大肥鱼是雷点，必须写进人格卡');
  assert.match(text, /1~10 字/, '长度纪律');
  assert.match(text, /括号/, '括号内容会被当正式消息发出去，必须写清楚');
  assert.match(text, /首先/, 'AI 味黑名单');
  assert.match(text, /越权|拒绝/, '底线');
  assert.ok(text.length < 2600, `人格卡太长会挤占上下文：${text.length}`);
});

test('面板体检：没配主人时报红，配好之后转绿', async () => {
  const { ctx, host, dataDir } = setup();
  const panel = ctx.routes.find((r) => r.path.endsWith('/panel'));
  const read = async () => { let out = ''; await panel.handler({ url: '/qq-companion/api/panel' }, { setHeader() {}, end: (s) => { out = s; } }); return out; };

  assert.match(await read(), /❌ 主人 QQ/);
  const cfg = ctx.routes.find((r) => r.path.endsWith('/config'));
  await cfg.handler(formRequest({ ownerQQ: '42' }), { setHeader() {}, end: () => {} });
  const after = await read();
  assert.match(after, /✅ 主人 QQ/, after.slice(0, 400));
  assert.ok(dataDir);
  assert.ok(host.config.ownerQQ === '42');
});

test('改配置：连接参数变了会重启网关', async () => {
  const { ctx, host } = setup();
  let restarted = 0;
  host.onebot.restart = () => { restarted += 1; };
  const route = ctx.routes.find((r) => r.path.endsWith('/config'));
  const req = {
    method: 'POST',
    on: (ev, cb) => {
      if (ev === 'data') cb(JSON.stringify({ onebot: { wsUrl: 'ws://127.0.0.1:3999' } }));
      if (ev === 'end') setTimeout(cb, 0);
    },
  };
  let out = '';
  await route.handler(req, { setHeader() {}, end: (s) => { out = s; } });
  assert.equal(JSON.parse(out).ok, true);
  assert.equal(host.config.onebot.wsUrl, 'ws://127.0.0.1:3999');
  assert.equal(restarted, 1, '连接参数变了应该重连');
});

test('启动失败不炸宿主：apply 返回错误而不是抛', () => {
  const r = apply(null);
  assert.ok(r.error, '应带上错误原因');
});

test('没有 llm 服务：用到时给一句能看懂的错，不是 undefined 崩溃', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-nollm-'));
  const ctx = { webServer: { register: () => () => {} }, effect: (fn) => fn() };
  const host = createHost(ctx, { dataDir, now: () => 0, log: quiet, autoStart: false });
  await assert.rejects(
    () => host.session.prompt('p', '在吗'),
    /没有提供 llm 服务/,
  );
});

test('配置只写了一半：嵌套默认值不能被抹掉', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-partial-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42', onebot: { token: 'T' } }));
  const host = createHost(fakeCtx(), { dataDir, now: () => 0, log: quiet, autoStart: false });
  assert.equal(host.config.ownerQQ, '42');
  assert.equal(host.config.onebot.token, 'T');
  assert.equal(host.config.onebot.wsUrl, 'ws://127.0.0.1:3001', '默认地址不能被抹掉');
  assert.equal(host.config.onebot.httpUrl, 'http://127.0.0.1:3000', 'HTTP 与 WS 是两个端口');
  assert.equal(host.config.session.replyDelayMs, 800, 'session 的默认值也要在');
});

test('装上：写默认配置与人格，注册路由，网关空地址不崩', () => {
  const { ctx, host, dataDir } = setup();
  const cfg = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.persona, '小鲸鱼');
  assert.ok(readFileSync(join(dataDir, 'personas', '小鲸鱼.md'), 'utf8').includes('小鲸鱼'));
  assert.ok(ctx.routes.some((r) => r.path.endsWith('/state')));
  assert.equal(host.onebot.state, 'stopped', '默认地址没连上也不该抛错');
});

test('群聊与陌生人：在到达网络之前就被挡掉', async () => {
  const { host } = setup();
  assert.deepEqual(await host.handleEvent({ post_type: 'message', message_type: 'group', group_id: 9, user_id: 1 }), { ignored: 'not-private' });
  assert.deepEqual(await host.handleEvent({ post_type: 'notice' }), { ignored: 'not-private' });
});

test('面板回滚：点链接把特质退回快照', async () => {
  const { ctx, dataDir } = setup();
  const st = initState(0);
  st.self.attachment = 0.9;
  st.self.snapshots = [{ at: 1234, traits: { attachment: 0.5 }, narrative: '' }];
  writeFileSync(join(dataDir, 'affect.json'), JSON.stringify(st));

  const panel = ctx.routes.find((r) => r.path.endsWith('/panel'));
  const state = ctx.routes.find((r) => r.path.endsWith('/state'));
  let out = '';
  await panel.handler({ url: '/qq-companion/api/panel?rollback=1234' }, { setHeader() {}, end: (s) => { out = s; } });
  assert.match(out, /<!doctype html>/);
  let json = '';
  await state.handler({ method: 'GET' }, { setHeader() {}, end: (s) => { json = s; } });
  const body = JSON.parse(json);
  assert.equal(body.state.self.attachment, 0.5, '应回到快照里的值');
});

test('面板路由：返回 HTML，不是 JSON', async () => {
  const { ctx } = setup();
  const route = ctx.routes.find((r) => r.path.endsWith('/panel'));
  assert.ok(route, '没有注册 panel 路由');
  let out = '';
  let type = '';
  await route.handler({ method: 'GET' }, { setHeader: (k, v) => { if (k === 'content-type') type = v; }, end: (s) => { out = s; } });
  assert.match(type, /text\/html/);
  assert.match(out, /心情/);
  assert.match(out, /<\/html>/);
});

test('状态路由：能返回一行可读状态', async () => {
  const { ctx, host } = setup();
  const route = ctx.routes.find((r) => r.path.endsWith('/state'));
  let out = '';
  await route.handler({ method: 'GET' }, { setHeader() {}, end: (s) => { out = s; } });
  const body = JSON.parse(out);
  assert.equal(body.ok, true);
  assert.match(body.line, /心情/);
  assert.equal(host.companion.snapshot().version, 1);
});

test('记忆：主人私聊会被记住，下一轮注入块里能读到', async () => {
  const { host, ctx } = setup();
  const first = await host.memory.block({ text: '我养了一只猫，叫团子', userId: '42' });
  const second = await host.memory.block({ text: '今天加班到十点', userId: '42' });
  assert.match(second, /团子/, '上一句的猫应该在记忆里');
  assert.doesNotMatch(first, /团子/, '这一句已经在本轮对话里，不该再冒充「过去」进记忆块');
  const card = host.memory.card();
  assert.equal(card.records.length, 2);

  // 观测点：面板必须能看到「这一轮想起了什么」
  const route = ctx.routes.find((r) => r.path.endsWith('/state'));
  let out = '';
  await route.handler({ method: 'GET' }, { setHeader() {}, end: (s) => { out = s; } });
  const body = JSON.parse(out);
  assert.equal(body.recalls.length, 2);
  assert.ok(body.recalls[0].picks.some((t) => t.includes('团子')), JSON.stringify(body.recalls));
});

test('人格读写：保存后下一条回复就用新的', async () => {
  const { ctx, dataDir } = setup();
  const route = ctx.routes.find((r) => r.path.endsWith('/persona'));
  let out = '';
  const handlers = { on: (ev, cb) => { if (ev === 'end') setTimeout(cb, 0); } };
  const req = {
    method: 'POST',
    on: (ev, cb) => {
      if (ev === 'data') cb(JSON.stringify({ name: '小鲸鱼', text: '你是另一个她' }));
      if (ev === 'end') setTimeout(cb, 0);
    },
  };
  void handlers;
  await route.handler(req, { setHeader() {}, end: (s) => { out = s; } });
  assert.equal(JSON.parse(out).ok, true);
  assert.match(readFileSync(join(dataDir, 'personas', '小鲸鱼.md'), 'utf8'), /另一个她/);
});

// ---- 她的当下 ----
const systemOf = (call) => (call?.messages || []).filter((m) => m.role === 'system')
  .map((m) => m.content.map((c) => c.text).join('')).join('\n');

function lifeSetup(replies, startClock = 0, opts = {}) {
  const { aliveBefore = 0, ...hostOpts } = opts;
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-life-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
  // 必须赶在 createHost 之前写：她在开机那一刻读自己的「上次醒着」。
  if (aliveBefore) writeFileSync(join(dataDir, 'alive.json'), JSON.stringify({ at: aliveBefore }));
  let clock = startClock;
  const ctx = fakeCtx({ replies });
  const host = createHost(ctx, { dataDir, now: () => clock, log: quiet, autoStart: false, sleep: async () => {}, ...hostOpts });
  const tick = (ms) => { clock += ms; };
  const ask = () => host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: '在吗' });
  return { ctx, host, dataDir, tick, ask };
}

test('她的当下：自己定、落盘、之后每句话都看得见，且不会重复问', async () => {
  const { ctx, host, dataDir, ask } = lifeSetup(['在收拾东西|30']);
  const life = await host.life.refresh();
  assert.equal(life.doing, '在收拾东西');
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'life.json'), 'utf8')).doing, '在收拾东西');

  ctx.calls.length = 0;
  await ask();
  assert.equal(ctx.calls.length, 1, '一句话只该调用一次模型：她的当下不能按句计费');
  assert.match(systemOf(ctx.calls[0]), /你此刻：在收拾东西/);

  ctx.calls.length = 0;
  await host.life.refresh();
  assert.equal(ctx.calls.length, 0, '还没到点就不该再问');
});

test('她的当下：到点就清空，别让她半夜还在收拾东西', async () => {
  const { ctx, host, tick, ask } = lifeSetup(['在收拾东西|30']);
  await host.life.refresh();
  tick(31 * 60e3);
  ctx.calls.length = 0;
  await ask();
  assert.equal(ctx.calls.length, 1);
  assert.doesNotMatch(systemOf(ctx.calls[0]), /你此刻/);
});

test('她的当下：重启后读到早就过期的 life.json，不能接着用', async () => {
  const { host, dataDir, tick } = lifeSetup(['在看书|60']);
  writeFileSync(join(dataDir, 'life.json'), JSON.stringify({ doing: '在看书', until: 30 * 60e3 }));
  tick(2 * 86400e3);
  assert.equal(host.life.state().doing, '');
  assert.equal(await host.life.line(), '');
});

test('她的当下：问不出来就留空，不写占位句子，也别每条消息重问', async () => {
  const { ctx, host } = lifeSetup(['不知道']);
  const life = await host.life.refresh();
  assert.equal(life.doing, '');
  assert.equal(await host.life.line(), '');
  ctx.calls.length = 0;
  await host.life.refresh();
  assert.equal(ctx.calls.length, 0, '空答也要留闸，否则每次都在烧 token');
});

test('她的当下：模型报错不能把她弄哑', async () => {
  const { ctx, host, ask } = lifeSetup([]);
  ctx.llm.stream = () => { throw new Error('boom'); };
  assert.equal((await host.life.refresh()).doing, '');
  assert.ok(host.companion, '插件还得活着');
  void ask;
});

// ---- 日记 ----
test('日记：23 点后她写一条，素材是真事，一天不重写', async () => {
  const start = new Date(2026, 9, 28, 23, 30).getTime();
  const { ctx, host, dataDir } = lifeSetup(['今天他一直在忙。'], start);
  await host.memory.block({ text: '他明天要考试', userId: '42' });

  ctx.calls.length = 0;
  assert.equal(await host.diary.refresh(), '2026-10-28');
  assert.equal(readFileSync(join(dataDir, 'diary', '2026-10-28.md'), 'utf8'), '今天他一直在忙。');
  assert.match(systemOf(ctx.calls[0]), /大肥鱼/, '日记要用她自己的人格卡写');
  const userText = ctx.calls[0].messages.find((m) => m.role === 'user').content[0].text;
  assert.match(userText, /他明天要考试/, '今天记下的真事要进日记');
  assert.match(userText, /2026-10-28/);

  ctx.calls.length = 0;
  assert.equal(await host.diary.refresh(), null);
  assert.equal(ctx.calls.length, 0, '同一天不重写');
  assert.deepEqual(host.diary.list(3).map((x) => x.date), ['2026-10-28']);
});

test('日记：一天什么都没发生就不写空话', async () => {
  const start = new Date(2026, 9, 28, 23, 30).getTime();
  const { ctx, host, dataDir } = lifeSetup(['不该被叫到'], start);
  assert.equal(await host.diary.refresh(), null);
  assert.equal(ctx.calls.length, 0);
  assert.equal(existsSync(join(dataDir, 'diary')), false);
});

// 「比昨天模糊」只有在昨天真的存在时才成立：晚上关机、几天没开机，中间是断的。
function diaryGapSetup(snapshotDate) {
  const start = new Date(2026, 9, 28, 9, 0).getTime();
  const env = lifeSetup(['补上。'], start);
  let card = createCard(0);
  card = remember(card, '他昨天去面试了', { now: new Date(2026, 9, 27, 15, 0).getTime() });
  card = remember(card, '他很早以前提过一句想吃拉面', { now: new Date(2026, 8, 1, 12, 0).getTime() });
  const faint = card.records.find((r) => r.text.includes('拉面'));
  faint.clarity = 'trace';
  faint.importance = 40; // 不够重要会被「只剩印象 + 不重要」的规则真删掉，那样就测不到降档了
  const fresh = card.records.find((r) => r.text.includes('面试'));
  writeFileSync(join(env.dataDir, 'memory.json'), JSON.stringify(card));
  writeFileSync(join(env.dataDir, 'diary-snapshot.json'), JSON.stringify({
    date: snapshotDate,
    snap: { marks: { [faint.id]: 3, [fresh.id]: 3 }, compactions: 0 },
  }));
  return env;
}

test('日记：中间隔了几天，不说「比昨天模糊」', async () => {
  const { ctx, host } = diaryGapSetup('2026-10-24');
  assert.equal(await host.diary.refresh(), '2026-10-27');
  const prompt = ctx.calls[0].messages.find((m) => m.role === 'user').content[0].text;
  assert.match(prompt, /他昨天去面试了/);
  assert.doesNotMatch(prompt, /模糊/, '隔了四天，说「比昨天」是编的');
});

test('日记：昨天真存在时，模糊的条数照实说', async () => {
  // 写 10-27 的日记时，「昨天」是 10-26 —— 快照 date 存的是它写的那一天。
  const { ctx, host } = diaryGapSetup('2026-10-26');
  assert.equal(await host.diary.refresh(), '2026-10-27');
  const prompt = ctx.calls[0].messages.find((m) => m.role === 'user').content[0].text;
  assert.match(prompt, /模糊/);
});

// ---- 钱 ----
test('账：一次回话记一笔 token，落盘、面板看得见', async () => {
  const { host, ask, dataDir } = lifeSetup(['嗯']);
  await ask();
  const b = host.budget.state();
  assert.equal(b.calls, 1);
  assert.equal(b.input, 120);
  assert.equal(b.output, 30);
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'budget.json'), 'utf8')).calls, 1);
  assert.match(renderPanel({ state: initState(0), memory: createCard(0), budget: b, now: 0 }), /钱包/);
});

test('钱：余额查得到就说一句，查不到就不说钱', async () => {
  const { ctx, host, dataDir, ask } = lifeSetup(['嗯']);
  writeFileSync(join(dataDir, 'budget.json'), JSON.stringify({
    calls: 3, input: 1000, output: 100, cached: 0, balance: { ok: true, total: 13.23, currency: 'CNY', at: 0 },
  }));
  ctx.calls.length = 0;
  await ask();
  const sys = systemOf(ctx.calls[0]);
  assert.match(sys, /13\.23 元/);
  assert.match(sys, /3 次话/);
  assert.match(sys, /别主动提/);

  writeFileSync(join(dataDir, 'budget.json'), JSON.stringify({
    calls: 3, input: 1000, output: 100, cached: 0, balance: { ok: false, reason: 'HTTP 401' },
  }));
  ctx.calls.length = 0;
  await ask();
  assert.doesNotMatch(systemOf(ctx.calls[0]), /元/, '查不到余额时一个钱的数字都不能出现');
});

test('余额：走凭据服务查，失败后退避，不再每十分钟撞墙', async () => {
  let hits = 0;
  const fetchImpl = async () => { hits += 1; return { ok: false, status: 401, json: async () => ({}) }; };
  const { host, ctx } = lifeSetup([], 0, { fetchImpl });
  ctx.get = (n) => (n === 'credentials' ? { resolve: async () => ({ value: 'sk-test' }) } : undefined);

  const first = await host.budget.refresh();
  assert.equal(first.ok, false);
  assert.match(first.reason, /401/);
  assert.equal(hits, 1);

  const second = await host.budget.refresh();
  assert.equal(second.ok, false);
  assert.equal(hits, 1, '同一个失败不该一直重试');
});

test('余额：没有凭据服务也不崩，只是查不到', async () => {
  const { host } = lifeSetup([]);
  const b = await host.budget.refresh();
  assert.equal(b.ok, false);
  assert.ok(b.reason);
});

// ---- 她不在的那段时间 ----
test('关机九小时后开机：她知道刚才没有自己（这是事实，不是台词）', async () => {
  const bootAt = new Date(2026, 9, 28, 8, 0).getTime();
  const last = new Date(2026, 9, 27, 22, 14).getTime();
  const { ctx, host, ask } = lifeSetup(['嗯'], bootAt, { aliveBefore: last });
  assert.equal(host.alive.before, last);

  await ask();
  const sys = systemOf(ctx.calls[0]);
  assert.match(sys, /你刚才不在了 9 小时 46 分/);
  assert.match(sys, /上次醒着是 昨天 22:14/);
});

test('开机两小时后：不再翻旧账，别每分钟提醒她死过一次', async () => {
  const bootAt = new Date(2026, 9, 28, 8, 0).getTime();
  const last = new Date(2026, 9, 27, 22, 14).getTime();
  const { ctx, host, tick, ask } = lifeSetup(['嗯'], bootAt, { aliveBefore: last });
  tick(3 * 3600e3);
  await ask();
  assert.doesNotMatch(systemOf(ctx.calls[0]), /刚才不在/);
});

test('机器睡了四小时（进程被冻住）：醒来那次心跳也算「她不在」', async () => {
  const bootAt = new Date(2026, 9, 28, 8, 0).getTime();
  const { ctx, host, tick, ask } = lifeSetup(['嗯'], bootAt);
  await host.tick();
  tick(4 * 3600e3);
  await host.tick();
  await ask();
  assert.match(systemOf(ctx.calls.at(-1)), /你刚才不在了 4 小时/);
});

test('连发三条：一次模型调用、三条记忆、一条回复', async () => {
  const timers = [];
  const later = (fn) => { timers.push(fn); return timers.length - 1; };
  const clear = (h) => { if (typeof h === 'number') timers[h] = null; };
  const { ctx, host } = lifeSetup(['嗯'], 0, { mergeWindowMs: 3000, later, clear });
  const ev = (text) => ({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: text });

  const p1 = host.handleEvent(ev('在吗'));
  const p2 = host.handleEvent(ev('睡了吗'));
  const p3 = host.handleEvent(ev('我跟你说个事'));
  assert.equal(ctx.calls.length, 0, '窗口没到，不该调模型');

  timers.findLast((f) => typeof f === 'function')();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.merged, 3);
  assert.equal(r2.sent, r3.sent, '同一批拿到同一个结果');
  assert.equal(ctx.calls.length, 1, '三条只该调一次模型');

  const userText = ctx.calls[0].messages.filter((m) => m.role === 'user').at(-1).content[0].text;
  assert.match(userText, /在吗[\s\S]*睡了吗[\s\S]*我跟你说个事/, '三句都要在，顺序不变');
  assert.equal(host.memory.card().records.length, 3, '每条原话各存一条记忆');
});


test('面板路由：她的房间确实接上了当下和日记文件', async () => {
  const start = new Date(2026, 9, 28, 23, 30).getTime();
  const { ctx, dataDir } = lifeSetup([], start);
  writeFileSync(join(dataDir, 'life.json'), JSON.stringify({ doing: '在看书', until: start + 30 * 60e3 }));
  mkdirSync(join(dataDir, 'diary'), { recursive: true });
  writeFileSync(join(dataDir, 'diary', '2026-10-28.md'), '今天他一直在忙。');

  const route = ctx.routes.find((r) => r.path.endsWith('/panel'));
  let out = '';
  await route.handler({ method: 'GET', url: '/qq-companion/api/panel' }, { setHeader() {}, end: (s) => { out = s; } });
  assert.match(out, /她的房间/);
  assert.match(out, /在看书/);
  assert.match(out, /今天他一直在忙/);
});

test('日记：23 点前补的是昨天，素材也只能是昨天的事', async () => {
  const start = new Date(2026, 9, 28, 10, 0).getTime();
  const { ctx, host, dataDir } = lifeSetup(['补上昨天。'], start);
  let card = remember(createCard(0), '他昨天去面试了', { now: new Date(2026, 9, 27, 15, 0).getTime() });
  card = remember(card, '他今天说想吃火锅', { now: start });
  writeFileSync(join(dataDir, 'memory.json'), JSON.stringify(card));

  assert.equal(await host.diary.refresh(), '2026-10-27');
  const prompt = ctx.calls[0].messages.find((m) => m.role === 'user').content[0].text;
  assert.match(prompt, /他昨天去面试了/);
  assert.doesNotMatch(prompt, /火锅/, '今天的事不能写进昨天的日记');
});

test('日记：23 点前写的是昨天，不会把今天写成昨天', async () => {
  // 注意：把「昨天的事」真的造在昨天。否则今天记下的一条会被算进昨天的日记——那正是要防的 bug。
  const start = new Date(2026, 9, 27, 10, 0).getTime();
  const { host, tick } = lifeSetup(['补上昨天。'], start);
  await host.memory.block({ text: '他今天去面试了', userId: '42' });
  tick(24 * 3600e3); // 到 10-28 10:00：这时该补的是 10-27
  assert.equal(await host.diary.refresh(), '2026-10-27');
});

test('她的当下：输出预算给够了，不会被推理吃掉（60 那次就是这么空的）', async () => {
  const { ctx, host } = lifeSetup(['在收拾东西|30']);
  await host.life.refresh();
  assert.ok(ctx.calls[0].maxTokens >= 200, `定当下只给了 ${ctx.calls[0].maxTokens} token，推理模型会返回空`);
});

test('合并转发：里面的聊天记录她真的读得到', async () => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/get_forward_msg')) {
      asked.push(String(init?.body || ''));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: {
            messages: [
              { sender: { nickname: '璃湘' }, message: [{ type: 'text', data: { text: '我为什么要去健身' } }] },
              { sender: { nickname: '肥鱼' }, message: [{ type: 'text', data: { text: '你想想呗' } }] },
            ],
          },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
  };
  const { ctx, host } = lifeSetup(['嗯'], 0, { fetchImpl, mergeWindowMs: 0 });

  await host.handleEvent({
    post_type: 'message', message_type: 'private', user_id: 42, time: 1000,
    message: [{ type: 'forward', data: { id: 'RES_ID_1' } }],
  });

  assert.equal(asked.length, 1, '应该去查了一次转发内容');
  assert.match(asked[0], /RES_ID_1/);
  const sent = ctx.calls[0].messages.filter((m) => m.role === 'user').at(-1);
  const text = sent.content.map((c) => c.text || '').join('');
  assert.match(text, /璃湘：我为什么要去健身/, '转发的正文要进她的上下文');
  assert.match(text, /不是他说的/, '得说清这些话不是他说的');
});

// ---- 人格分层 ----
const NOON = new Date(2026, 0, 1, 14, 0, 0).getTime();
const say = (raw) => ({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: raw, time: Math.floor(NOON / 1000) });

test('人格卡分层：system 里只有内核和风格默认，情境按这一轮另拼', async () => {
  const { ctx, host } = lifeSetup(['嗯'], NOON, { mergeWindowMs: 0 });
  await host.handleEvent(say('在吗'));
  const sys = systemOf(ctx.calls[0]);
  assert.match(sys, /大肥鱼/, '内核一个字都不能少');
  assert.match(sys, /1~10 字/, '风格默认也要在');
  assert.doesNotMatch(sys, /劝过一次就够/, '中午说「在吗」不该拿到深夜那条情境');
});

test('他要一段长的：条数放宽，对应的情境也跟着进上下文', async () => {
  const { ctx, host } = lifeSetup(['那得从很早说起了'], NOON, { mergeWindowMs: 0 });
  const r = await host.handleEvent(say('给我讲讲你以前的事'));
  const sys = systemOf(ctx.calls[0]);
  assert.match(sys, /可以连发几条/, '「讲讲」是明确要一段长的');
  assert.equal(r.plan.maxParts, 4, '平常心情 2 条，加 2 条余量；不能还是 2');
});

test('讲道理不是要长内容：不给她破例', async () => {
  const { ctx, host } = lifeSetup(['嗯'], NOON, { mergeWindowMs: 0 });
  const r = await host.handleEvent(say('别跟我讲道理'));
  assert.doesNotMatch(systemOf(ctx.calls[0]), /可以连发几条/);
  assert.equal(r.plan.maxParts, 2);
});

test('她绕回来了：连着三轮催睡，第三轮之后要点她一下', async () => {
  const { ctx, host } = lifeSetup(['去睡吧', '快去睡吧', '去睡啦', '嗯'], NOON, { mergeWindowMs: 0 });
  await host.handleEvent(say('还不困'));
  await host.handleEvent(say('再聊会'));
  await host.handleEvent(say('我不困'));
  assert.doesNotMatch(systemOf(ctx.calls[0]), /绕回来/, '第一轮就提示会变成噪音');
  await host.handleEvent(say('真的不困'));
  assert.match(systemOf(ctx.calls[3]), /你已经绕回来了/);
});

// ---- 她知道你在电脑上干什么 ----
test('开关：默认关，关着的时候一次都不去读', async () => {
  let reads = 0;
  const { ctx, host } = lifeSetup(['嗯'], NOON, {
    mergeWindowMs: 0,
    screenReader: async () => { reads += 1; return { app: 'Code', title: 'x' }; },
  });
  await host.handleEvent(say('在吗'));
  assert.equal(reads, 0, '没开就一次都不许碰他的屏幕');
  assert.doesNotMatch(systemOf(ctx.calls[0]), /他此刻/);
});

test('开着：她知道你在哪个窗口，五分钟内不重复去读', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-screen-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42', screen: { enabled: true } }));
  let clock = NOON;
  let reads = 0;
  const ctx = fakeCtx({ replies: ['嗯', '啊', '？'] });
  const host = createHost(ctx, {
    dataDir, now: () => clock, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0,
    screenReader: async () => { reads += 1; return { app: 'Code', title: 'qq-companion — host.js' }; },
  });
  const hi = (t) => ({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: t, time: Math.floor(clock / 1000) });

  await host.handleEvent(hi('在吗'));
  assert.match(systemOf(ctx.calls[0]), /他此刻：在 Code「qq-companion — host\.js」/);
  assert.match(systemOf(ctx.calls[0]), /刚刚看到的/);

  clock += 60e3;
  await host.handleEvent(hi('在吗在吗'));
  assert.equal(reads, 1, '一分钟内再聊，不该又 spawn 一次 PowerShell');

  clock += 6 * 60e3;
  await host.handleEvent(hi('人呢'));
  assert.equal(reads, 2, '过了时限才重新读');
});

test('读到了密码管理器：她什么都没看见', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-screen2-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42', screen: { enabled: true } }));
  const ctx = fakeCtx({ replies: ['嗯'] });
  const host = createHost(ctx, {
    dataDir, now: () => NOON, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0,
    screenReader: async () => ({ app: '1Password', title: 'vault' }),
  });
  await host.handleEvent(say('在吗'));
  assert.doesNotMatch(systemOf(ctx.calls[0]), /1Password/);
  assert.doesNotMatch(systemOf(ctx.calls[0]), /他此刻/);
});

// ---- 表情包与上网：她回复里的方括号指令 ----
const gwOk = (record, body) => {
  record.push(String(body));
  return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
};

test('她发表情：标记不发给他的话，图另起一条', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-sticker-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
  writeFileSync(join(dataDir, 'stickers.json'), JSON.stringify({
    at: NOON,
    items: [{ md5: 'a', url: 'https://p.qpic.cn/qq_expression/a/0', name: '无语' }],
  }));
  const sent = [];
  const fetchImpl = async (url, init) => gwOk(sent, init?.body);
  const ctx = fakeCtx({ replies: ['不用猜了[表情:无语]'] });
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0, fetchImpl });

  const r = await host.handleEvent(say('他自己也糊涂了'));

  const texts = sent.filter((b) => b.includes('"text"'));
  const images = sent.filter((b) => b.includes('"image"'));
  assert.equal(texts.length, 1, '先说一句');
  assert.match(texts[0], /不用猜了/);
  assert.doesNotMatch(texts[0], /表情:/, '方括号指令不能发到他手机上');
  assert.equal(images.length, 1, '表情单独一条');
  assert.match(images[0], /p\.qpic\.cn/);
  assert.deepEqual(r.sticker, { sent: true, name: '无语' });
});

test('表情挑不到：不发，也不报错', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-sticker2-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
  writeFileSync(join(dataDir, 'stickers.json'), JSON.stringify({ at: NOON, items: [{ md5: 'a', url: 'https://p.qpic.cn/a/0', name: '无语' }] }));
  const sent = [];
  const fetchImpl = async (url, init) => gwOk(sent, init?.body);
  const ctx = fakeCtx({ replies: ['笑死[表情:狂笑]'] });
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0, fetchImpl });
  const r = await host.handleEvent(say('哈哈'));
  assert.equal(sent.filter((b) => b.includes('"image"')).length, 0);
  assert.equal(r.sticker.sent, false);
});

test('她说要查：搜完带着材料重说一遍，发出去的是第二版', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-search-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    ownerQQ: '42', search: { enabled: true, key: 'k', maxPerDay: 5 },
  }));
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('tavily.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          answer: '杭州明天小雨',
          results: [{ title: '天气', url: 'https://weather.example.com/hz', content: '杭州明天小雨转阴，8~14℃，东北风 3 级' }],
        }),
      };
    }
    return gwOk(sent, init?.body);
  };
  const ctx = fakeCtx({ replies: ['我查一下[查:杭州明天天气]', '明天下雨，带伞'] });
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0, fetchImpl });

  await host.handleEvent(say('明天什么天气'));

  assert.equal(ctx.calls.length, 2, '查完要再问她一遍');
  assert.match(systemOf(ctx.calls[1]), /你刚查到的/);
  assert.match(systemOf(ctx.calls[1]), /weather\.example\.com/, '得带来源');
  assert.match(systemOf(ctx.calls[1]), /8~14℃/, '给她的是材料，不是一句总结');
  assert.match(sent.at(-1), /带伞/, '发出去的是第二版');
  assert.doesNotMatch(sent.join(''), /\[查/, '指令不能发出去');
});

test('一条回复里写两个 [查]：两个都查，不只查第一个', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-search2-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    ownerQQ: '42', search: { enabled: true, key: 'k', maxPerDay: 5 },
  }));
  const sent = [];
  const asked = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('tavily.com')) {
      const q = JSON.parse(init.body).query;
      asked.push(q);
      return {
        ok: true,
        status: 200,
        json: async () => ({ answer: `${q}的答案`, results: [{ title: 't', url: 'https://ex.example.com/a', content: `${q}的正文` }] }),
      };
    }
    return gwOk(sent, init?.body);
  };
  const ctx = fakeCtx({ replies: ['我查一下[查:杭州天气][查:明天限行]', '天气和限行都查了'] });
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0, fetchImpl });

  await host.handleEvent(say('明天出门要注意啥'));

  assert.deepEqual(asked, ['杭州天气', '明天限行'], '两个都要真的查');
  const sys = systemOf(ctx.calls[1]);
  assert.match(sys, /杭州天气的正文/);
  assert.match(sys, /明天限行的正文/);
  assert.doesNotMatch(sent.join(''), /\[查/, '指令不能发出去');
});

test('三个 [查] 只查前两条：一次把一天的额度烧光不值得', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-search3-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    ownerQQ: '42', search: { enabled: true, key: 'k', maxPerDay: 5 },
  }));
  const sent = [];
  const asked = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('tavily.com')) {
      const q = JSON.parse(init.body).query;
      asked.push(q);
      return { ok: true, status: 200, json: async () => ({ answer: `${q}的答案`, results: [{ title: 't', url: 'https://ex.example.com/a', content: `${q}的正文` }] }) };
    }
    return gwOk(sent, init?.body);
  };
  const ctx = fakeCtx({ replies: ['[查:a1][查:b1][查:c1]', '查到了'] });
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0, fetchImpl });

  await host.handleEvent(say('帮我查三件事'));

  assert.equal(asked.length, 2);
});

test('发图那一轮：正文只留「他发了一张图」，画面描述进 detail 不进上下文', async () => {
  const { host } = setup();
  const pic = '（你看了一眼他刚发来的图：一个穿红裙子的女孩站在雨里。知道就行，别复述）好不好看';
  await host.memory.block({ text: pic, parts: [pic], userId: '42' }, { heat: 0.8 });

  const rec = host.memory.card().records.at(-1);
  assert.equal(rec.text, '他发了一张图好不好看');
  assert.match(rec.detail, /红裙子/, '画面留在 detail 里，不丢');
  assert.equal(rec.heat, 0.8, '那一刻的重量要存下来');

  const block = await host.memory.block({ text: '再聊点别的', parts: ['再聊点别的'], userId: '42' });
  assert.match(block, /他发了一张图/, '她得记得发过图');
  assert.doesNotMatch(block, /红裙子/, '但不能每轮都把画面念一遍');
});

test('记忆带上下文：下一轮记得上一轮他问的那句', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-ask-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
  const sent = [];
  const fetchImpl = async (url, init) => gwOk(sent, init?.body);
  const ctx = fakeCtx({ replies: ['金发那个啊', '她叫菲比'] });
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0, fetchImpl });

  await host.handleEvent(say('金发那个叫什么'));
  await host.handleEvent(say('她叫菲比'));

  const rec = host.memory.card().records.at(-1);
  assert.equal(rec.text, '她叫菲比');
  assert.equal(rec.askedBy, '金发那个叫什么', '「她」是谁，得跟着那句话一起记住');
});

test('面板表情：图能看见、名字能改、试发真的发出去', async () => {  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-sticker-panel-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
  writeFileSync(join(dataDir, 'stickers.json'), JSON.stringify({
    at: NOON,
    items: [{ md5: 'm1', url: 'https://p.qpic.cn/qq_expression/m1/0', name: '' }],
  }));
  const sent = [];
  const fetchImpl = async (url, init) => gwOk(sent, init?.body);
  const ctx = fakeCtx();
  createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false, fetchImpl });
  const panel = ctx.routes.find((r) => r.path.endsWith('/panel'));
  const call = async (url) => { let out = ''; await panel.handler({ url }, { setHeader() {}, end: (s) => { out = s; } }); return out; };

  const html = await call('/qq-companion/api/panel');
  assert.match(html, /qq_expression\/m1/, '面板上要看得到那张图');
  assert.match(html, /没名字/, '没名字的要标出来');

  await call(`/qq-companion/api/panel?ren=m1&as=${encodeURIComponent('震惊')}`);
  const saved = JSON.parse(readFileSync(join(dataDir, 'stickers.json'), 'utf8'));
  assert.equal(saved.items[0].name, '震惊', '改的名字要落盘，不然重启就白改了');

  await call('/qq-companion/api/panel?sendst=m1');
  assert.ok(sent.some((b) => b.includes('qq_expression/m1')), '试发要真的发出去');
});

test('一轮说完就往账本里记一行，且不记他说的内容', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-blog-host-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
  const sent = [];
  const fetchImpl = async (url, init) => gwOk(sent, init?.body);
  const ctx = fakeCtx({ replies: ['嗯，我在呢'] });
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0, fetchImpl });

  await host.handleEvent(say('在吗'));

  const d = new Date(NOON);
  const file = join(dataDir, `behavior-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, '一轮一行');
  const e = JSON.parse(lines[0]);
  assert.ok(e.parts >= 1);
  assert.ok(e.chars > 0);
  assert.equal(e.open, '嗯，我在呢');
  assert.equal(JSON.stringify(e).includes('在吗'), false, '他说的一个字都不进账本');
});

test('情绪落到记忆上：那一刻的心情和重量都存下来', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-feel-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
  const sent = [];
  const fetchImpl = async (url, init) => gwOk(sent, init?.body);
  const ctx = fakeCtx({ reply: '嗯嗯' });
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0, fetchImpl });

  await host.handleEvent(say('我真的好喜欢你'));

  const rec = host.memory.card().records.at(-1);
  assert.ok(rec.feel && rec.feel.v > 0.55, '记下它时的心情');
  assert.ok(rec.heat > 0, '那一刻的重量（为 0 就等于三档记忆没上线）');
});

test('心跳会写周自述：不然那句「我最近」过期就永远消失', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-insights-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
  const ctx = fakeCtx();
  ctx.llm.stream = async function* () {
    yield { type: 'text-delta', text: 'work|最近过得还行\ngrowth|我学会了不催他' };
    yield { type: 'finish', reason: { kind: 'done' } };
  };
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false, sleep: async () => {} });

  await host.memory.block({ text: '他喜欢猫', userId: '42' });
  await host.tick();
  // 心跳里的刷新是排进队列的，不 await：再排一个同队列的空操作，等它就是在等前一个。
  await host.insights.refresh();

  const ins = host.insights.state();
  assert.ok(ins.at > 0, '心跳要真的写下这一周的自我叙述');
  assert.ok(ins.lines.length >= 2);
});

test('陌生人私聊：叫不动她，也不会把原话塞进你的下一轮', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-stranger-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
  const sent = [];
  const fetchImpl = async (url, init) => gwOk(sent, init?.body);
  const ctx = fakeCtx({ reply: '嗯，我在' });
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0, fetchImpl });

  appendTranscript(dataDir, { at: NOON - 60e3, role: 'user', text: '明天要去面试' });
  const r = await host.handleEvent({
    post_type: 'message', message_type: 'private', user_id: 99,
    raw_message: '你还记得上次那个面试吗', time: Math.floor(NOON / 1000),
  });
  assert.deepEqual(r, { ignored: 'not-owner' });
  assert.equal(ctx.calls.length, 0, '陌生人叫不动她');

  await host.handleEvent(say('在吗'));
  assert.doesNotMatch(systemOf(ctx.calls[0]), /翻到的原话/, '陌生人的话不能漏进你的上下文');
});

test('一条回复里三张图：看不了也要说清只看了两张', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-manyimg-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
  const sent = [];
  const fetchImpl = async (url, init) => gwOk(sent, init?.body);
  const ctx = fakeCtx({ reply: '好看' });
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0, fetchImpl });

  const img = (n) => ({ type: 'image', data: { url: `https://p.qpic.cn/x/${n}` } });
  await host.handleEvent({
    post_type: 'message', message_type: 'private', user_id: 42,
    message: [{ type: 'text', data: { text: '看这几张' } }, img(1), img(2), img(3)],
    time: Math.floor(NOON / 1000),
  });

  const rec = host.memory.card().records.at(-1);
  assert.match(rec.text, /还有|没看/, '要让她知道自己漏看了，不然她会当成全看过');
});

test('重答时归档只有发出去的那版：草稿不算她说过的话', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-draft-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    ownerQQ: '42', search: { enabled: true, key: 'k', maxPerDay: 5 },
  }));
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('tavily.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ answer: '杭州明天小雨', results: [{ title: 't', url: 'https://w.example.com/a', content: '杭州明天小雨转阴' }] }),
      };
    }
    return gwOk(sent, init?.body);
  };
  const ctx = fakeCtx({ replies: ['我查一下[查:杭州天气]', '明天下雨，带伞'] });
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0, fetchImpl });

  await host.handleEvent(say('明天什么天气'));

  const rows = readFileSync(join(dataDir, 'transcript-2026-01.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const hers = rows.filter((r) => r.role === 'assistant').map((r) => r.text);
  assert.deepEqual(hers, ['明天下雨，带伞'], '第一版草稿从没发出去过，不能进归档');
});

test('想起一件事：把那天的前后两句一起带出来', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-scene-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
  const ctx = fakeCtx();
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false });

  appendTranscript(dataDir, { at: NOON - 60e3, role: 'user', text: '明天有个面试' });
  appendTranscript(dataDir, { at: NOON, role: 'assistant', text: '会是哪家呀' });
  appendTranscript(dataDir, { at: NOON + 60e3, role: 'user', text: '一家做芯片的' });
  await host.memory.block({ text: '他明天有面试', parts: ['他明天有面试'], userId: '42' });

  const block = await host.memory.block({ text: '那个面试怎么样了', parts: ['那个面试怎么样了'], userId: '42' });
  assert.match(block, /那天的前后/);
  assert.match(block, /明天有个面试/);
  assert.match(block, /一家做芯片的/, '前后各一条，结论才有场景');
});

test('没命中任何记忆：不去翻归档，也不占上下文', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-scene2-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
  const ctx = fakeCtx();
  const host = createHost(ctx, { dataDir, now: () => NOON, log: quiet, autoStart: false });
  await host.memory.block({ text: '他明天有面试', parts: ['他明天有面试'], userId: '42' });

  const block = await host.memory.block({ text: '今天天气咋样', parts: ['今天天气咋样'], userId: '42' });
  assert.doesNotMatch(block, /那天的前后/);
});