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

// ---- 羞：她不是什么都接 ----
// 以前这里没有这一类，所以他往那个方向说的时候她的状态一点都没变，
// 于是只能顺着他的话往下滑——那不是性格，是没人拦。

test('羞：低愉悦 + 高唤醒，而且比他说的更露时反应更强', () => {
  const bold = appraise('🦌');
  assert.equal(bold.emotion.label, '羞');
  assert.ok(bold.emotion.v < 0.5, '不是高兴');
  assert.ok(bold.emotion.a > 0.7, '心跳快，但不等于开心');
  const mild = appraise('我刚洗完澡了');
  assert.equal(mild.emotion.label, '羞', '「刚洗完澡」是引子，也算');
  assert.ok(mild.emotion.intensity < bold.emotion.intensity, '引子比露骨轻一档');
});

test('羞不能把「被夸」吃掉：抱抱、摸摸这种还是当夸', () => {
  // 亲密词表里要是混进 PRAISE 已有的词，被夸就整个变成羞了。
  assert.equal(appraise('抱抱').emotion.label, '被夸');
  assert.equal(appraise('宝贝摸摸').emotion.label, '被夸');
});

test('骂还是骂：带撩的词也不能把「被凶」盖掉', () => {
  assert.equal(appraise('闭嘴，别在床上说这个').emotion.label, '被凶');
});

test('兜底热度：认不出情绪的一句话，也可能很有分量', () => {
  // 她多久忘掉一件事，全靠这个数。没有它，"吼了一句"和"今天吃了黄焖鸡"一样轻。
  assert.equal(appraise('今天下雨了').heat, 0);
  assert.ok(appraise('你怎么这样！！！！').heat > 0.2, '连发感叹号的话是有分量的');
  assert.ok(appraise('我没事，就是有点想跟你说说话，今天从早上一直忙到现在，饭都没吃').heat >= 0.12, '一口气说很长');
  // 有情绪的句子不叠两层：热度就是那一刻的强度。
  const hurt = appraise('闭嘴');
  assert.equal(hurt.heat, hurt.emotion.intensity);
  // 空输入什么都没发生。
  assert.equal(appraise('').heat, 0);
});
