// 看屏兜底：动作 JSON 的抠取、给看图模型的提示、一局跑完后的材料。
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionNote, parseVisionAction, runVisionSession, visionPrompt } from '../src/games/vision.js';

const GAME = {
  id: 'lightsout', title: '点灯', summary: '点一盏灯，它和上下左右一起翻转', controls: '点格子',
  start: 'document.getElementById("btn-start").click()',
  done: "!document.getElementById('over-overlay').classList.contains('hidden')",
  read: '{"moves":3}',
};

test('抠动作：正常 JSON、带代码围栏、多说两句都认；坏格式/坏坐标不认', () => {
  assert.deepEqual(parseVisionAction('{"look":"灯亮着","action":{"kind":"click","x":10,"y":20}}'),
    { look: '灯亮着', action: { kind: 'click', x: 10, y: 20 } });
  assert.deepEqual(parseVisionAction('```json\n{"look":"该按左","action":{"kind":"key","key":"左"}}\n```'),
    { look: '该按左', action: { kind: 'key', key: 'ArrowLeft' } });
  assert.deepEqual(parseVisionAction('行，我先等：{"look":"还在闪","action":{"kind":"wait","ms":99999}}'),
    { look: '还在闪', action: { kind: 'wait', ms: 10000 } });
  assert.deepEqual(parseVisionAction('{"action":{"kind":"quit"}}'), { look: '', action: { kind: 'quit' } });
  assert.equal(parseVisionAction('看不懂'), null);
  assert.equal(parseVisionAction('{"action":{"kind":"click","x":-1,"y":2}}'), null);
  assert.equal(parseVisionAction('{"action":{"kind":"key","key":"Hyper"}}'), null);
});

test('给看图模型的提示：带游戏名、规则、画面尺寸、一次一步', () => {
  const p = visionPrompt({ game: GAME, width: 1280, height: 800, recent: ['上一眼灯亮着'] });
  assert.match(p, /《点灯》/);
  assert.match(p, /点格子/);
  assert.match(p, /1280×800/);
  assert.match(p, /一次只做一步/);
  assert.match(p, /上一眼灯亮着/);
  assert.equal(actionNote({ action: { kind: 'click', x: 3, y: 4 } }), '点了 (3,4)');
  assert.equal(actionNote({ action: { kind: 'key', key: 'Space' } }), '按了 Space');
});

function fakeBrowser({ doneAfter = 1 } = {}) {
  const calls = { evals: [], clicks: [], keys: [] };
  let doneChecks = 0;
  let clicks = 0;
  return {
    calls,
    async evaluate(expr) {
      calls.evals.push(expr);
      if (/over-overlay/.test(expr)) { doneChecks += 1; return doneChecks > doneAfter; }
      if (expr === GAME.read) return '{"moves":3}';
      return 'ok';
    },
    async screenshot() { return { dataUrl: 'data:image/jpeg;base64,AAAA', width: 1280, height: 800 }; },
    async click(x, y) { clicks += 1; calls.clicks.push([x, y]); },
    async key(k) { clicks += 1; calls.keys.push(k); },
  };
}

test('看屏一局：截一张、点一下、赢了；材料只报次数和看到的话', async () => {
  const browser = fakeBrowser({ doneAfter: 1 });
  const out = await runVisionSession(GAME, {
    browser,
    see: async () => '{"look":"看到一盏亮着的灯","action":{"kind":"click","x":10,"y":20}}',
    progress: { wins: 1 },
    maxMinutes: 5, maxDecisions: 10, stepMs: 1,
    now: (() => { let t = 1000; return () => { t += 100; return t; }; })(),
  });
  assert.equal(out.victory, true);
  assert.equal(out.clicks, 1);
  assert.deepEqual(browser.calls.clicks, [[10, 20]]);
  assert.deepEqual(out.observations, ['看到一盏亮着的灯']);
  assert.match(out.facts, /点 1 下/);
  assert.match(out.facts, /游戏记了 3 步/);
  assert.match(out.facts, /这一局玩完了/);
  assert.equal(out.progress.wins, 2);
  assert.equal(out.progress.plays, 1);
});

test('看屏一局：看不懂这一步就等一手，不假装玩过', async () => {
  const browser = fakeBrowser({ doneAfter: 99 });
  const out = await runVisionSession(GAME, {
    browser,
    see: async () => '嗯？',
    maxMinutes: 5, maxDecisions: 1, stepMs: 1,
    now: (() => { let t = 1000; return () => { t += 100; return t; }; })(),
  });
  assert.equal(out.decisions, 1);
  assert.equal(out.clicks, 0);
  assert.equal(out.victory, false);
  assert.match(out.facts, /点 0 下/);
  assert.ok(out.actions.some((a) => /没看懂/.test(a.note)));
});

test('看屏一局：看图接口挂了就收摊，不记成玩过', async () => {
  const browser = fakeBrowser({ doneAfter: 99 });
  let asked = 0;
  const out = await runVisionSession(GAME, {
    browser,
    see: async () => { asked += 1; throw new Error('HTTP 500'); },
    maxMinutes: 5, maxDecisions: 5, stepMs: 1,
    now: (() => { let t = 1000; return () => { t += 100; return t; }; })(),
  });
  assert.equal(asked, 2, '看一眼失败再试一次');
  assert.equal(out.reason, 'error');
  assert.equal(out.decisions, 0);
  assert.match(out.facts, /点 0 下/);
});
