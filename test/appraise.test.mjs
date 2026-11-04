// 规则评估的判据：夸、骂、追问、路过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { appraise, intensityOf } from '../src/affect/appraise.js';
import { DAY_MS, applyDamage, initState } from '../src/affect/core.js';

test('被夸：效价上去，不产生伤害', () => {
  const r = appraise('你好可爱，真棒');
  assert.ok(r.emotion.v >= 0.7);
  assert.equal(r.damage, 0);
});

test('被骂：效价下来、唤醒上去，产生伤害', () => {
  const r = appraise('你真烦，闭嘴');
  assert.ok(r.emotion.v <= 0.2);
  assert.ok(r.emotion.a >= 0.7);
  assert.ok(r.damage > 0 && r.damage <= 0.1);
  assert.ok(r.emotion.intensity >= 0.4);
});

test('骂得越多伤害越大，但单次不超过 0.10', () => {
  const one = appraise('垃圾');
  const many = appraise('垃圾 废物 恶心 滚');
  assert.ok(many.damage >= one.damage);
  assert.ok(many.damage <= 0.1);
});

test('群里的路过吐槽：不记账、只轻推一下情绪', () => {
  const r = appraise('这游戏真垃圾', { direct: false });
  assert.equal(r.damage, 0);
  assert.ok(r.emotion.intensity <= 0.4);
});

test('普通闲聊不产生情绪事件', () => {
  assert.equal(appraise('今天下雨了').emotion, null);
  assert.equal(appraise('').emotion, null);
});

test('追问只提唤醒，不改效价', () => {
  const r = appraise('你在吗？');
  assert.equal(r.emotion.v, 0.5);
  assert.ok(r.emotion.a > 0.5);
});

test('否定翻转：「我不开心」是低落，不是被夸', () => {
  const r = appraise('我不开心');
  assert.equal(r.damage, 0, '倾诉不该记账');
  assert.equal(r.emotion.label, '低落');
  assert.ok(r.emotion.v < 0.5);
});

test('弱否定也算否定：「不太开心」「没那么喜欢」不是夸', () => {
  const a = appraise('我不太开心');
  assert.equal(a.emotion.label, '低落');
  assert.equal(a.damage, 0);

  const b = appraise('我没那么喜欢你');
  assert.ok(b.emotion.v < 0.5, `实际 ${b.emotion.v}`);
  assert.equal(b.damage, 0);
});

test('「特别」不是否定：特别喜欢仍然是夸', () => {
  const r = appraise('我特别喜欢你');
  assert.equal(r.emotion.v, 0.8);
});

test('否定式骂人：「你不讨厌」算夸', () => {
  const r = appraise('你不讨厌');
  assert.equal(r.damage, 0);
  assert.equal(r.emotion.v, 0.8);
});

test('倾诉：难过记情绪、不记伤害', () => {
  const r = appraise('我最近好难受');
  assert.equal(r.damage, 0);
  assert.equal(r.emotion.label, '低落');
  assert.equal(r.emotion.a, 0.3);
});

test('混合情绪：气笑了是中性高唤醒', () => {
  const r = appraise('真是气笑了');
  assert.equal(r.mixed, true);
  assert.equal(r.emotion.v, 0.5);
  assert.ok(r.emotion.a >= 0.7);
});

test('强度外溢：连发感叹/重复字更高', () => {
  assert.ok(intensityOf('哈哈哈哈哈') > intensityOf('哈哈'));
  assert.ok(intensityOf('好开心！！！') > intensityOf('好开心'));
  assert.ok(intensityOf('有点开心') < intensityOf('开心'));
});

test('接上关系层：一次骂只扣 0.04 信任', () => {
  const r = appraise('闭嘴');
  assert.ok(r.damage > 0, '「闭嘴」是明确的骂，应产生伤害');
  const s = applyDamage(initState(0), r.damage, 0).state;
  assert.ok(s.relation.trust < 0.5 && s.relation.trust > 0.45);
  assert.ok(s.relation.guard > 0.2);
  assert.ok(DAY_MS > 0);
});
