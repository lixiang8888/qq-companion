// 每周一次的自述：从一堆记忆里，让她自己说出三句稳定的认识。
//
// 为什么不是每天：日有日记，月有人格漂移，中间缺一层「我最近对他什么看法」。
// 三类固定，是因为让模型自由发挥会写成小作文；固定三类各自有界，才能一直读得下去。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInsights, composePrompt, createInsights, dueInsights, parseInsights, renderInsights } from '../src/insights.js';
import { createCard, remember } from '../src/memory/card.js';

const T = Date.UTC(2026, 9, 30);
const DAY = 86400e3;

test('解析：三类各一句，认不出的类别直接丢', () => {
  const lines = parseInsights([
    '- work|最近总在等他说完话才敢说自己的',
    'us｜我们最近聊得少，但我不慌',
    'nonsense|随便写写',
    'growth：「-」',
  ].join('\n'));
  assert.deepEqual(lines.map((l) => l.kind), ['work', 'us']);
  assert.match(lines[0].text, /等他说完/);
});

test('解析：同一类只留第一句，别写成一串清单', () => {
  const lines = parseInsights('us|第一句\nus|第二句');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '第一句');
});

test('解析：空输入返回空数组，不抛', () => {
  for (const bad of ['', '   ', null, undefined]) assert.deepEqual(parseInsights(bad), []);
});

test('每类最多 20 条：一直写下去也是有界的', () => {
  let ins = createInsights(0);
  for (let i = 0; i < 25; i++) ins = applyInsights(ins, [{ kind: 'us', text: `第${i}句` }], T + i);
  assert.equal(ins.lines.filter((l) => l.kind === 'us').length, 20);
  assert.equal(ins.lines.at(-1).text, '第24句', '留最新的');
});

test('同样的句子不重复记', () => {
  let ins = applyInsights(createInsights(0), [{ kind: 'us', text: '我们最近挺稳' }], T);
  ins = applyInsights(ins, [{ kind: 'us', text: '我们最近挺稳' }], T + 1);
  assert.equal(ins.lines.length, 1);
});

test('一周一次：昨天写过就不再写，隔了 8 天再写', () => {
  const ins = applyInsights(createInsights(0), [{ kind: 'us', text: '我们最近挺稳' }], T);
  assert.equal(dueInsights(ins, T + 6 * DAY), false);
  assert.equal(dueInsights(ins, T + 8 * DAY), true);
  assert.equal(dueInsights(createInsights(0), T), true, '第一次也没有');
});

test('注入：每类取最新一句，拼成一行；没有就返回空串', () => {
  assert.equal(renderInsights(createInsights(0)), '');
  const ins = applyInsights(createInsights(0), [
    { kind: 'work', text: '最近总在等他说完话' },
    { kind: 'us', text: '我们最近聊得少，但我不慌' },
    { kind: 'growth', text: '我学会不追问了' },
  ], T);
  const line = renderInsights(ins);
  assert.match(line, /【你最近的想法】/);
  assert.match(line, /等他说完/);
  assert.match(line, /不追问/);
  assert.equal(line.split('\n').length, 1, '只能占一行');
});

test('提示词：只给真实记忆，并且允许她写不出来', () => {
  let card = createCard(T);
  card = remember(card, '他养了只猫，叫团子', { now: T });
  const p = composePrompt(card, { now: T });
  assert.match(p, /团子/);
  assert.match(p, /work/);
  assert.match(p, /us/);
  assert.match(p, /growth/);
  assert.match(p, /不要编/);

  assert.equal(composePrompt(createCard(T), { now: T }), '', '没有记忆就什么都不问');
});
