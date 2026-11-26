// 她玩游戏：整条链路（她自己挑 → 起无头浏览器 → 驱动跑一局 → 局后感想 → 战绩 → 注入 → 看屏兜底）。
// 浏览器和驱动都是假的（真的那层用 .tmp 的冒烟脚本验），但走的是 host 里真实的流程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.js';

const quiet = { warn() {}, info() {}, error() {} };
const H = 3600e3;
const T = new Date(2026, 10, 22, 12, 0, 0).getTime();
const REACTION = '「得分 10」不算白玩，好歹过了一关。[玩:爽 3]';
const SEE_REPLY = '{"look":"看到一盏亮着的灯","action":{"kind":"click","x":10,"y":20}}';

function fakeCtx({ turn = '[动]', reaction = REACTION, credentials = null } = {}) {
  const calls = [];
  return {
    calls,
    get: (name) => (name === 'credentials' && credentials ? { resolve: async () => credentials } : undefined),
    llm: {
      listProviders: () => ['deepseek-official'],
      listModels: async () => [{ id: 'deepseek-flash' }],
      async *stream(opts) {
        calls.push(opts);
        const all = (opts.messages || []).map((m) => (m.content || []).map((c) => c.text || '').join('')).join('\n');
        let text = '嗯';
        if (/这一回合做什么/.test(all)) text = turn;
        else if (/【这一局】/.test(all)) text = reaction;
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } };
        yield { type: 'finish', reason: { kind: 'done' } };
      },
    },
    systemPrompt: { variable: () => () => {} },
    webServer: { register: () => () => {} },
    effect: (fn) => { fn(); return () => {}; },
  };
}

function fakeBrowser(calls, { doneAfter = 2 } = {}) {
  return {
    async open(entry, opts) { calls.open.push({ entry, ready: opts?.ready }); },
    async close() { calls.close += 1; },
    async evaluate(expr) {
      calls.evals.push(expr);
      if (/over-overlay/.test(expr)) { calls.doneChecks += 1; return calls.doneChecks >= doneAfter; }
      if (/moves/.test(expr)) return '{"moves":3}';
      return 'ok';
    },
    async screenshot() { return { dataUrl: 'data:image/jpeg;base64,AAAA', width: 1280, height: 800 }; },
    async click(x, y) { calls.clicks.push([x, y]); },
    async key(k) { calls.keys.push(k); },
  };
}

const fakeDriver = (calls) => ({
  create: () => ({
    id: 'fake', title: '假游戏', stepMs: 1, maxDecisions: 20, maxMinutes: 5,
    async prepare() { calls.prepare += 1; },
    async read() {
      calls.reads += 1;
      return calls.reads >= 2 ? { victory: true } : { victory: false };
    },
    board() { return '假棋盘'; },
    prompt() { return { instructions: '假规则', user: '这一回合做什么？', maxTokens: 100 }; },
    parse(reply) { return /不玩/.test(reply) ? { kind: 'quit' } : { kind: 'move' }; },
    async apply() { calls.apply += 1; return { ok: true }; },
    done(s) { return { over: Boolean(s?.victory), victory: Boolean(s?.victory) }; },
    finish({ state, quit }) {
      return {
        facts: quit ? '假游戏：她自己不想玩了，得分 10' : '假游戏：赢了，得分 10',
        victory: Boolean(state?.victory) && !quit,
        progress: { plays: 1, best: 10 },
      };
    },
  }),
});

const FAKE_CATALOG = [{ id: 'fake', title: '假游戏', kind: 'structured', entry: 'fake/index.html', ready: '' }];
const VISION_CATALOG = [{
  id: 'lights', title: '点灯', kind: 'vision', entry: 'lights/index.html', ready: '',
  start: 'document.getElementById("btn-start").click()',
  done: '!document.getElementById("over-overlay").classList.contains("hidden")',
  read: '{"moves":3}',
}];

function setup({ catalog = FAKE_CATALOG, drivers = null, ctxOpts = {}, doneAfter = 2 } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-game-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, ownerQQ: '42', onebot: { httpUrl: 'http://127.0.0.1:9' },
    game: { enabled: true, edgePath: 'C:\\fake\\msedge.exe', stepMs: 10, maxDecisions: 10, maxMinutes: 5, maxPerDay: 1 },
  }));
  const calls = { open: [], close: 0, evals: [], clicks: [], keys: [], reads: 0, apply: 0, prepare: 0, doneChecks: 0 };
  let clock = T;
  const ctx = fakeCtx(ctxOpts);
  const browser = fakeBrowser(calls, { doneAfter });
  const host = createHost(ctx, {
    dataDir,
    now: () => clock,
    log: quiet,
    autoStart: false,
    sleep: async () => {},
    browserFactory: () => browser,
    gameCatalog: catalog,
    drivers: drivers || { fake: fakeDriver(calls) },
    fetchImpl: async (url) => {
      if (String(url).includes('api.deepseek.com')) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: SEE_REPLY } }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    },
  });
  return { dataDir, ctx, host, calls, tick: (ms) => { clock += ms; } };
}

async function say(host, text = '去吧', ms = T) {
  await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: text, time: Math.floor(ms / 1000) });
}

test('她自己玩一局：真的开了浏览器、落了手、关了；局后感想带锚点，战绩/记忆/情绪都落盘', async () => {
  const { dataDir, ctx, host, calls, tick } = setup();
  await say(host);
  tick(40 * 60e3); // 他四十分钟没吭声

  const st = await host.game.play();
  assert.equal(calls.open.length, 1, '应该开过浏览器');
  assert.equal(calls.open[0].entry, 'fake/index.html');
  assert.equal(calls.close, 1, '一局结束必须关掉浏览器（不然会留着进程）');
  assert.equal(calls.prepare, 1);
  assert.ok(calls.reads >= 2, '至少读初始状态和结束状态');
  assert.equal(calls.apply, 1, '只过了一步就赢了');

  assert.equal(st.last.game, 'fake');
  assert.equal(st.last.title, '假游戏');
  assert.match(st.last.facts, /得分 10/);
  assert.equal(st.last.victory, true);
  assert.equal(st.last.label, '爽');
  assert.match(st.last.thought, /得分 10/);
  assert.equal(st.library.fake.plays, 1);
  assert.equal(st.library.fake.best, 10);

  // 记忆卡：有锚点的强感触才进
  const mem = JSON.parse(readFileSync(join(dataDir, 'memory.json'), 'utf8'));
  assert.ok(mem.records.some((r) => /假游戏/.test(r.text) && r.source === 'seen'));

  // 情绪：爽
  const aff = JSON.parse(readFileSync(join(dataDir, 'affect.json'), 'utf8'));
  assert.equal(aff.emotion.label, '爽');

  // 下一次聊天：上下文里带着「你最近在玩《假游戏》」
  const before = ctx.calls.length;
  await say(host, '在吗', T + 41 * 60e3);
  const systems = ctx.calls.slice(before).map((c) => (c.messages || []).filter((m) => m.role === 'system')
    .map((m) => (m.content || []).map((x) => x.text || '').join('')).join('\n'));
  assert.ok(systems.some((x) => /你最近在玩《假游戏》/.test(x)), '下轮她看得出自己刚玩过什么');
});

test('她说不想玩了：这一局按「她自己收的」记，不算赢', async () => {
  const { host, calls, tick } = setup({ ctxOpts: { turn: '不玩了' } });
  await say(host);
  tick(40 * 60e3);
  const st = await host.game.play();
  assert.equal(st.last.quit, true);
  assert.equal(st.last.victory, false);
  assert.equal(calls.close, 1, '不想玩了也要关浏览器');
});

test('他刚说完话就不开游戏：闸门在真事上', async () => {
  const { host, calls } = setup();
  await say(host);
  const st = await host.game.play();
  assert.equal(calls.open.length, 0, '刚说过话，不该开浏览器');
  assert.equal(st.last, null);
});

test('一天只玩一局', async () => {
  const { host, calls, tick } = setup();
  await say(host);
  tick(40 * 60e3);
  await host.game.play();
  assert.equal(calls.open.length, 1);
  tick(2 * H);
  await host.game.play();
  assert.equal(calls.open.length, 1, '今天已经玩过，第二局不开');
});

test('拿不到看图凭据：看屏游戏这轮跳过，不记账', async () => {
  const { host, calls, tick } = setup({ catalog: VISION_CATALOG, drivers: {} });
  await say(host);
  tick(40 * 60e3);
  const st = await host.game.play();
  assert.equal(calls.open.length, 0, '没有看图凭据就不开浏览器');
  assert.equal(st.last, null);
});

test('看屏兜底：截一张、点一下、赢了；材料只报次数和看到的话', async () => {
  const { host, calls, tick } = setup({ catalog: VISION_CATALOG, drivers: {}, ctxOpts: { credentials: 'k-123' } });
  await say(host);
  tick(40 * 60e3);
  const st = await host.game.play();
  assert.equal(calls.open.length, 1);
  assert.equal(calls.clicks.length, 1);
  assert.deepEqual(calls.clicks[0], [10, 20]);
  assert.equal(st.last.game, 'lights');
  assert.equal(st.last.victory, true);
  assert.match(st.last.facts, /点 1 下/);
  assert.match(st.last.facts, /游戏记了 3 步/);
  assert.equal(st.library.lights.wins, 1);
});
