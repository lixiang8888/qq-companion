// 感知记忆：模型输出 → 三个字段（标题/描述/语义槽）。解析失败也不能丢图。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePerception, slotsText, SLOT_KINDS } from '../src/perception/slots.js';

test('正常的 JSON：三个字段都拿到', () => {
  const r = parsePerception('{"title":"粉发女孩","desc":"一个粉色头发的女孩举着牌子","slots":{"who":["女孩"],"look":["粉发"]}}');
  assert.equal(r.title, '粉发女孩');
  assert.equal(r.desc, '一个粉色头发的女孩举着牌子');
  assert.deepEqual(r.slots.who, ['女孩']);
  assert.deepEqual(r.slots.what, [], '没给的槽是空数组，不是 undefined');
});

test('带代码围栏也能解析', () => {
  const r = parsePerception('```json\n{"title":"猫","desc":"一只猫"}\n```');
  assert.equal(r.title, '猫');
  assert.equal(r.desc, '一只猫');
});

test('完全不按格式：整段当 desc，标题截前 30 字，槽留空（图不能丢）', () => {
  const prose = '画面中有一个戴帽子的金发像素女孩在点头，动作循环。';
  const r = parsePerception(prose);
  assert.equal(r.desc, prose);
  assert.equal(r.title, prose.slice(0, 30));
  assert.deepEqual(r.slots.who, []);
});

test('JSON 里没 desc：用 title 顶上，正文不能为空', () => {
  const r = parsePerception('{"title":"猫"}');
  assert.equal(r.desc, '猫');
});

test('槽值不是数组：忽略，不炸', () => {
  const r = parsePerception('{"title":"t","desc":"d","slots":{"who":"女孩"}}');
  assert.deepEqual(r.slots.who, []);
});

test('slotsText 把标题、描述和所有槽拼成可检索文本', () => {
  const text = slotsText({ title: '粉发女孩', desc: '举着牌子', slots: { who: ['女孩'], look: ['粉发'] } });
  for (const part of ['粉发女孩', '举着牌子', '女孩']) assert.ok(text.includes(part), part);
});

test('SLOT_KINDS 是那五类', () => {
  assert.deepEqual(SLOT_KINDS, ['who', 'what', 'where', 'action', 'look']);
});
