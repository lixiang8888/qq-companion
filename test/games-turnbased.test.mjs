// 结构化游戏的公共回合循环：暂停/继续配对、上限、空回复、想不出来、落子失败、收尾。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runStructuredSession } from '../src/games/turnbased.js';

function fixture({ spec: over = {}, ask: askImpl } = {}) {
  const log = [];
  const spec = {
    id: 'fake', title: '假游戏', stepMs: 1, maxDecisions: 10, maxMinutes: 10,
    async prepare() { log.push(['prepare']); },
    async pause({ on }) { log.push(['pause', on]); },
    async beforeTurn() { log.push(['before']); },
    async read() { return { victory: log.filter((x) => x[0] === 'apply').length >= 1 }; },
    board() { return '棋盘'; },
    prompt() { log.push(['prompt']); return { instructions: '规则', user: '这一手？', maxTokens: 10 }; },
    parse(reply) { return reply === 'quit' ? { kind: 'quit' } : reply === '等' ? { kind: 'wait' } : { kind: 'move' }; },
    async apply() { log.push(['apply']); return { ok: true }; },
    done(state) { return { over: Boolean(state?.victory), victory: Boolean(state?.victory) }; },
    finish({ state, progress }) {
      log.push(['finish', state]);
      return { facts: '打完了', progress: { ...(progress || {}), plays: 1 }, victory: Boolean(state?.victory) };
    },
    ...over,
  };
  const ask = askImpl || (async () => '[动]');
  return { spec, log, ask };
}

test('一局：准备、暂停→读→问→继续→落子→再暂停；过关就收摊', async () => {
  const { spec, log, ask } = fixture();
  const out = await runStructuredSession(spec, { browser: {}, ask, progress: { level: 2 } });
  assert.equal(out.facts, '打完了');
  assert.equal(out.victory, true);
  assert.equal(out.reason, 'victory');
  assert.equal(out.decisions, 1);
  assert.deepEqual(log.filter((x) => x[0] === 'prepare'), [['prepare']]);
  assert.deepEqual(log.filter((x) => x[0] === 'pause'), [['pause', true], ['pause', false], ['pause', true]]);
  assert.equal(log.filter((x) => x[0] === 'apply').length, 1);
  assert.deepEqual(out.progress, { level: 2, plays: 1 });
});

test('她说不想玩了：这一局按「她自己收的」记', async () => {
  const { spec, ask } = fixture({ ask: async () => 'quit' });
  const out = await runStructuredSession(spec, { browser: {}, ask });
  assert.equal(out.quit, true);
  assert.equal(out.reason, 'quit');
  assert.equal(out.decisions, 1, '说「不玩了」也算她做了这一手');
});

test('想不出来（两次都抛）：这一局收摊，但按当前状态记完', async () => {
  let n = 0;
  const { spec, log, ask } = fixture({ ask: async () => { n += 1; throw new Error('模型挂了'); } });
  const out = await runStructuredSession(spec, { browser: {}, ask });
  assert.equal(out.reason, 'error');
  assert.equal(n, 2, '第一次失败再问一次，第二次才收摊');
  assert.ok(out.notes.some((x) => /收摊/.test(x)));
  assert.ok(log.some((x) => x[0] === 'finish'), '收摊也要 finish，把真实状态写下来');
});

test('空回复算等一手，不白丢回合；到达上限就收', async () => {
  let calls = 0;
  const { spec } = fixture({
    spec: { maxDecisions: 2, async read() { return { victory: false }; } },
    ask: async () => { calls += 1; return ''; },
  });
  const out = await runStructuredSession(spec, { browser: {}, ask: async () => { calls += 1; return ''; } });
  assert.equal(calls, 4, '每次空回复会再问一次，两回合共四次');
  assert.equal(out.decisions, 2);
  assert.equal(out.reason, 'cap');
  assert.equal(out.notes.filter((x) => /空回复/.test(x)).length, 2);
});

test('到达决定数上限就停；wait 不算落子，但算一手', async () => {
  const { spec, log } = fixture({
    spec: { maxDecisions: 2, async read() { return { victory: false }; } },
    ask: async () => '等',
  });
  const out = await runStructuredSession(spec, { browser: {}, ask: async () => '等' });
  assert.equal(out.decisions, 2);
  assert.equal(log.filter((x) => x[0] === 'apply').length, 0);
  assert.equal(out.reason, 'cap');
});

test('落子失败不打断这一局，记进材料', async () => {
  let applied = 0;
  const { spec } = fixture({
    spec: {
      maxDecisions: 2,
      async read() { return { victory: false }; },
      async apply() { applied += 1; throw new Error('点空了'); },
    },
  });
  const out = await runStructuredSession(spec, { browser: {}, ask: async () => '[动]' });
  assert.equal(applied, 2);
  assert.ok(out.notes.some((x) => /点空了/.test(x)));
});

test('开局就已经结束：不问她，直接记', async () => {
  let asked = 0;
  const { spec, log } = fixture({
    spec: { async read() { return { victory: true }; } },
    ask: async () => { asked += 1; return 'x'; },
  });
  const out = await runStructuredSession(spec, { browser: {}, ask: async () => { asked += 1; return 'x'; } });
  assert.equal(asked, 0);
  assert.equal(out.victory, true);
  assert.equal(out.reason, 'victory');
  assert.ok(log.some((x) => x[0] === 'finish'));
});
