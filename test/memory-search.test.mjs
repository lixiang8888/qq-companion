// 检索：中文二元切词 + BM25-lite，以及「按需召回」在注入块里的效果。
import test from 'node:test';
import assert from 'node:assert/strict';
import { search, tokenize } from '../src/memory/search.js';
import { createCard, remember, render } from '../src/memory/card.js';

const T0 = Date.UTC(2026, 0, 1);

test('切词：中文二元组，英文整词，停用字不成组', () => {
  assert.deepEqual(tokenize('他喜欢猫'), ['他喜', '喜欢', '欢猫']);
  assert.deepEqual(tokenize('DeepSeek 好用'), ['deepseek', '好用']);
  assert.ok(!tokenize('的了是').includes('的'));
});

test('检索：相关的那条排在无关的前面', () => {
  const records = [
    { text: '他喜欢猫，家里养了一只叫团子', importance: 50, lastSeenAt: T0, clarity: 'clear' },
    { text: '今天加班到十点，很累', importance: 50, lastSeenAt: T0, clarity: 'clear' },
  ];
  const hits = search(records, '团子最近怎么样', { now: T0 });
  assert.equal(hits[0].rec.text.includes('团子'), true);
});

test('检索：重要且清楚的记录，评分更高（同样字面命中）', () => {
  const base = { text: '他喜欢吃辣', lastSeenAt: T0, clarity: 'fuzzy', importance: 20 };
  const strong = { ...base, importance: 90, clarity: 'vivid' };
  const hits = search([base, strong], '吃辣', { now: T0 });
  assert.equal(hits[0].rec, strong);
});

test('检索：没有交集就返回空，不硬凑', () => {
  assert.deepEqual(search([{ text: '他喜欢猫', importance: 50, lastSeenAt: T0, clarity: 'clear' }], '股票'), []);
});

test('注入：带上 query 时，旧但相关的记忆会挤进来', () => {
  let card = createCard(T0);
  card = remember(card, '他养了一只猫叫团子', { now: T0 });
  for (let i = 0; i < 12; i++) card = remember(card, `第 ${i} 条无关的新事，占位置用`, { now: T0 + 1000 * (i + 1) });
  const narrow = render(card, { now: T0 + 20_000, maxChars: 120, query: '团子' });
  const plain = render(card, { now: T0 + 20_000, maxChars: 120 });
  assert.match(narrow, /团子/, '问了团子就必须想起来');
  assert.ok(!plain.includes('团子'), '不问的时候不必占预算');
});
