// 她的空闲时间：一次只做一件（看书 or 打僵尸），选哪个由真事决定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.js';

const quiet = { warn() {}, info() {}, error() {} };
const H = 3600e3;
const T = new Date(2026, 10, 22, 20, 0, 0).getTime();

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
        if (/这一回合做什么/.test(all)) text = '[种:向日葵 1,1]';
        else if (/你刚自己看完一章/.test(all)) text = '看到「刺进」那段有点闷。[读:闷 2 继续]';
        else if (/你刚自己打完一局/.test(all)) text = '「第 1 关」就这。[玩:无感 1]';
        else if (/这是你自己在想/.test(all)) text = '{"send":true,"message":"喂"}';
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } };
        yield { type: 'finish', reason: { kind: 'done' } };
      },
    },
    systemPrompt: { variable: () => () => {} },
    webServer: { register: () => () => {} },
    effect: (fn) => { fn(); return () => {}; },
  };
}

const BODY = '　　他紧握手掌，尖锐的指甲深深的刺进了掌心之中，带来一阵阵钻心的疼痛。'.repeat(6);

function setup({ seedNovel = null, novelDown = false, config = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-pastime-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, ownerQQ: '42', onebot: { httpUrl: 'http://127.0.0.1:9' },
    novel: { base: 'http://127.0.0.1:1123' },
    game: { enabled: true, edgePath: 'C:\\fake\\msedge.exe', stepMs: 10, maxDecisions: 10, maxMinutes: 5, maxPerDay: 2 },
    ...config,
  }));
  if (seedNovel) writeFileSync(join(dataDir, 'novel.json'), JSON.stringify(seedNovel));
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (novelDown && /^\/get(Bookshelf|ChapterList|BookContent)$/.test(u.pathname)) {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1123');
    }
    if (u.pathname === '/getBookshelf') {
      return { ok: true, status: 200, json: async () => ({ data: [{ name: '斗破苍穹', bookUrl: 'http://x/1', totalChapterNum: 10, originName: '顶点小说' }] }) };
    }
    if (u.pathname === '/getChapterList') {
      return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, title: '第一章 陨落的天才' }] }) };
    }
    if (u.pathname === '/getBookContent') {
      return { ok: true, status: 200, json: async () => ({ data: BODY }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
  };
  let clock = T;
  const ctx = fakeCtx();
  const calls = { open: 0, close: 0, planted: [] };
  const pvzFactory = () => ({
    async open() { calls.open += 1; },
    async close() { calls.close += 1; },
    async paused() {},
    async collect() {},
    async plant(t, r, c) { calls.planted.push([t, r, c]); return 'ok'; },
    async setWaves() { return 'ok'; },
    async snapshot() { return { ready: true, sun: 200, wave: 1, maxWaves: 2, score: 0, defeated: 0, plants: [], zombies: [] }; },
  });
  const host = createHost(ctx, { dataDir, now: () => clock, log: quiet, autoStart: false, sleep: async () => {}, pvzFactory, fetchImpl });
  return { dataDir, host, calls, tick: (ms) => { clock += ms; } };
}

test('两边都能做时她只做一件：先去看书，游戏这轮不开', async () => {
  const { dataDir, host, calls, tick } = setup();
  await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: '我去忙了', time: Math.floor(T / 1000) });
  tick(40 * 60e3);
  const pick = await host.pastime();
  assert.equal(pick, 'read', '什么都没做过：平手选看书（她原来的习惯）');
  assert.equal(calls.open, 0, '看书的那轮绝不开游戏');
  assert.ok(existsSync(join(dataDir, 'novel.json')));
  assert.match(readFileSync(join(dataDir, 'novel.json'), 'utf8'), /斗破苍穹/);
  assert.ok(!existsSync(join(dataDir, 'game.json')) || !/last/.test(readFileSync(join(dataDir, 'game.json'), 'utf8')), '这一轮不该有游戏战绩');
});

test('书读不成（后端挂着）就换游戏：不让她每轮"选看书"然后干坐着', async () => {
  const { host, calls, tick } = setup({ novelDown: true });
  await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: '我去忙了', time: Math.floor(T / 1000) });
  tick(40 * 60e3);
  const pick = await host.pastime();
  assert.equal(pick, 'game', '本来选看书，书翻不开就换游戏');
  assert.equal(calls.open, 1, '真去打了');
});

test('小说读到腻了：这轮换成打游戏，不看书', async () => {
  const { dataDir, host, calls, tick } = setup({
    seedNovel: {
      at: T - 20 * 60e3, bookUrl: 'http://x/1', bookName: '斗破苍穹', index: 2,
      readsDay: '2026-11-22', readsToday: 3,
      books: { 'http://x/1': { name: '斗破苍穹', attitude: -0.4, reads: 3 } },
    },
  });
  await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: '我去忙了', time: Math.floor(T / 1000) });
  tick(40 * 60e3);
  const before = readFileSync(join(dataDir, 'novel.json'), 'utf8');
  const pick = await host.pastime();
  assert.equal(pick, 'game', '态度 -0.4：腻了，换花样');
  assert.equal(calls.open, 1, '真去开浏览器打了一局');
  assert.equal(readFileSync(join(dataDir, 'novel.json'), 'utf8'), before, '这轮不该读书——一章都没读');
});

test('一轮只做一件事：能找他时先找他，找过了才看书（不再两条通道一起跑）', async () => {
  const { dataDir, host, tick } = setup({ config: { proactive: { enabled: true, minIdleMinutes: 30, quietFrom: 0, quietTo: 0 } } });
  await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: '我去忙了', time: Math.floor(T / 1000) });
  tick(40 * 60e3);
  const first = await host.intent();
  assert.equal(first, 'talk', '期待到了：这一轮先找他');
  assert.ok(!existsSync(join(dataDir, 'novel.json')), '这一轮没去看书——一次只占一段时间');

  // 刚发完，冷却挡着：下一轮才轮到看书。
  tick(10 * 60e3);
  const second = await host.intent();
  assert.equal(second, 'read');
  assert.ok(existsSync(join(dataDir, 'novel.json')), '这一轮真读了');
});
