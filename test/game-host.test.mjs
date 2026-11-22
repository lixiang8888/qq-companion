// 她打游戏：整条链路（关卡 → 闸门 → 浏览器驱动 → 她决定 → 局后感想 → 战绩 → 注入）。
// 浏览器是假的（真的那层用 .tmp 的冒烟脚本验），但走的是 host 里真实的流程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.js';
import { bestOf } from '../src/game.js';

const quiet = { warn() {}, info() {}, error() {} };
const H = 3600e3;
const T = new Date(2026, 10, 22, 12, 0, 0).getTime();

const TURN_REPLY = '[种:向日葵 2,2]';
const REACTION = '撑到最后那波的时候手心都出汗了，「打掉 10 个」不是白打的，有点爽。[玩:爽 3]';

function fakeCtx() {
  const calls = [];
  return {
    calls,
    llm: {
      listProviders: () => ['deepseek-official'],
      listModels: async () => [{ id: 'deepseek-flash' }],
      async *stream(opts) {
        calls.push(opts);
        const all = (opts.messages || []).map((m) => (m.content || []).map((c) => c.text).join('')).join('\n');
        let text = '嗯';
        if (/这一回合做什么/.test(all)) text = TURN_REPLY;
        else if (/你刚自己打完一局/.test(all)) text = REACTION;
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

function setup({ turnReply = TURN_REPLY, snapshots } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-pvz-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, ownerQQ: '42', onebot: { httpUrl: 'http://127.0.0.1:9' },
    game: { enabled: true, edgePath: 'C:\\fake\\msedge.exe', stepMs: 10, maxDecisions: 30, maxMinutes: 10, maxPerDay: 1 },
  }));
  let clock = T;
  const ctx = fakeCtx();
  if (turnReply !== TURN_REPLY) {
    // 只改她这一手的回复，别复制整个 fakeCtx
    const stream = ctx.llm.stream;
    ctx.llm.stream = async function* patched(opts) {
      const all = (opts.messages || []).map((m) => (m.content || []).map((c) => c.text).join('')).join('\n');
      if (/这一回合做什么/.test(all)) {
        ctx.calls.push(opts);
        yield { type: 'text-delta', index: 0, text: turnReply };
        yield { type: 'finish', reason: { kind: 'done' } };
        return;
      }
      yield* stream.call(ctx.llm, opts);
    };
  }
  const calls = { open: 0, close: 0, paused: [], planted: [], waves: [] };
  const snaps = snapshots || [
    { ready: true, sun: 200, wave: 1, maxWaves: 2, score: 0, defeated: 0, plants: [], zombies: [] },
    { ready: true, sun: 150, wave: 2, maxWaves: 2, victory: true, score: 5000, defeated: 10, plants: [{ row: 1, col: 1, type: 'sunflower' }], zombies: [] },
  ];
  let i = 0;
  const pvzFactory = () => ({
    async open() { calls.open += 1; },
    async close() { calls.close += 1; },
    async paused(on) { calls.paused.push(on); },
    async collect() { return 1; },
    async plant(type, row, col) { calls.planted.push([type, row, col]); return 'ok'; },
    async setWaves(n) { calls.waves.push(n); return 'ok'; },
    async snapshot() { return snaps[Math.min(i++, snaps.length - 1)]; },
  });
  const host = createHost(ctx, {
    dataDir, now: () => clock, log: quiet, autoStart: false, sleep: async () => {}, pvzFactory,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  return { dataDir, ctx, host, calls, tick: (ms) => { clock += ms; } };
}

test('第一关她真的打了：两波、种了花、过关解锁第二关，战绩和记忆都落盘', async () => {
  const { dataDir, ctx, host, calls, tick } = setup();
  await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: '我去打把僵尸', time: Math.floor(T / 1000) });
  tick(40 * 60e3); // 他四十分钟没吭声

  const st = await host.game.play();
  assert.equal(calls.open, 1, '应该开过浏览器');
  assert.equal(calls.close, 1, '一局结束必须关掉浏览器（不然会留着进程）');
  assert.deepEqual(calls.waves, [2], '第一关只打两波——交给游戏自己的 maxWaves');
  assert.deepEqual(calls.planted, [['sunflower', 1, 1]], '她的指令真的执行了：第 2 行第 2 列');
  assert.equal(calls.paused[0], true, '先暂停再读战况：她想的这几秒不该被啃');

  assert.equal(st.last.level, 1);
  assert.equal(st.last.wave, 2);
  assert.equal(st.last.victory, true);
  assert.deepEqual(st.cleared, [1], '过了第一关');
  assert.equal(st.level, 2, '下一关是第 2 关');
  assert.equal(bestOf(st, 1).wave, 2);
  assert.equal(st.last.label, '爽');
  assert.match(st.last.thought, /手心都出汗/);
  assert.ok(existsSync(join(dataDir, 'game.json')));

  // 记忆卡：有锚点的强感触才进
  const mem = JSON.parse(readFileSync(join(dataDir, 'memory.json'), 'utf8'));
  const hit = mem.records.find((r) => /植物大战僵尸/.test(r.text));
  assert.ok(hit, '打僵尸这件事应该进记忆');
  assert.equal(hit.source, 'seen', '有真事做根，不是她自己想出来的');
  assert.match(hit.text, /第 1 关（2 波）/, '记忆里带关卡');

  // 情绪：爽
  const aff = JSON.parse(readFileSync(join(dataDir, 'affect.json'), 'utf8'));
  assert.equal(aff.emotion.label, '爽');

  // 下一次聊天：上下文里带着「你最近在打…」，而且带真实关卡和过关进度
  const before = ctx.calls.length;
  await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: '在吗', time: Math.floor((T + 41 * 60e3) / 1000) });
  const systems = ctx.calls.slice(before).map((c) => (c.messages || []).filter((m) => m.role === 'system')
    .map((m) => (m.content || []).map((x) => x.text).join('')).join('\n'));
  assert.ok(systems.some((s) => /你最近在打《植物大战僵尸》第 1 关/.test(s)), '下轮她看得出自己刚打过第几关');
  assert.ok(systems.some((s) => /已经过了第 1 关/.test(s)));
});

test('没解锁的植物种不了：第一关想种寒冰，这一手不算', async () => {
  const { host, calls, tick } = setup({ turnReply: '[种:寒冰 2,2]' });
  await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: '去吧', time: Math.floor(T / 1000) });
  tick(40 * 60e3);
  await host.game.play();
  assert.equal(calls.open, 1);
  assert.deepEqual(calls.planted, [], '寒冰是第三关的，第一关不许种');
});

test('他刚说完话就不开游戏：闸门在真事上', async () => {
  const { host, calls } = setup();
  await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: '在吗', time: Math.floor(T / 1000) });
  const st = await host.game.play();
  assert.equal(calls.open, 0, '十分钟前刚说过话，不该开浏览器');
  assert.equal(st.last, undefined);
});

test('一天只玩一局', async () => {
  const { host, calls, tick } = setup();
  await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: '去吧', time: Math.floor(T / 1000) });
  tick(40 * 60e3);
  await host.game.play();
  assert.equal(calls.open, 1);
  tick(2 * H);
  await host.game.play();
  assert.equal(calls.open, 1, '今天已经玩过，第二局不开');
});
