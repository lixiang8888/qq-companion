// 心里的念头：跟着话题冒、频率高但每次调用很小、过一阵回头看、可以跟旧想法相反。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_GAP_MS, MAX_PER_DAY, TTL_MS, SETTLE_MIN_MS, SETTLE_PER_DAY, TOPIC_WINDOW_MS,
  applySettle, applyThought, countToday, createImpulses, dueSettle, dueThought,
  noteTry, parseSettle, parseThought, renderImpulses, repeatThought, settledToday,
  settlePrompt, thoughtPrompt, topicOf,
} from '../src/impulse.js';

const HOUR = 3600e3;
const MIN = 60e3;

const state = ({ intensity = 0, mood = 0.5, label = '', v = 0.5 } = {}) => ({
  emotion: { intensity, label, v, a: 0.5, d: 0.5 },
  mood: { v: mood },
});

test('情绪上来才冒念头：强度够、心情极端，都算有来处', () => {
  const imp = createImpulses();
  const t = Date.UTC(2026, 10, 24, 10, 0);
  assert.equal(dueThought(state({ intensity: 0.6 }), imp, t), true, '刚被戳到');
  assert.equal(dueThought(state({ mood: 0.2 }), imp, t), true, '心情很低');
  assert.equal(dueThought(state({ mood: 0.8 }), imp, t), true, '心情很好');
  assert.equal(dueThought(state(), imp, t), false, '平平常常、也没话题，不硬想');
});

test('刚聊过就跟着冒：45 分钟内有他的话就算，过期就回到「情绪才有」', () => {
  const imp = createImpulses();
  const t = Date.UTC(2026, 10, 24, 10, 0);
  assert.equal(dueThought(state(), imp, t, { topicAt: t - 5 * MIN }), true, '他刚说过话');
  assert.equal(dueThought(state(), imp, t, { topicAt: t - 40 * MIN }), true, '还是在话题窗口里');
  assert.equal(dueThought(state(), imp, t, { topicAt: t - TOPIC_WINDOW_MS - MIN }), false, '太久没人说话，不算刚才');
  assert.equal(dueThought(state({ intensity: 0.7 }), imp, t, { topicAt: t - 3 * HOUR }), true, '没人说话但情绪上来了');
});

test('频率：8 分钟一个、一天最多 40 个', () => {
  // 本地上午起步：额度按本地午夜分界。
  const t0 = Date.UTC(2026, 10, 24, 2, 0);
  let imp = applyThought(createImpulses(), '算了，不想理他', t0, { v: 0.3 });
  assert.equal(dueThought(state(), imp, t0 + MIN_GAP_MS - 1, { topicAt: t0 }), false, '刚冒过别连着冒');
  assert.equal(dueThought(state(), imp, t0 + MIN_GAP_MS, { topicAt: t0 }), true);
  for (let i = 1; i < MAX_PER_DAY; i += 1) imp = applyThought(imp, `第 ${i} 个念头`, t0 + i * MIN_GAP_MS, { v: 0.3 });
  assert.equal(countToday(imp, t0 + 6 * HOUR), MAX_PER_DAY);
  assert.equal(dueThought(state(), imp, t0 + 6 * HOUR, { topicAt: t0 + 6 * HOUR }), false, '一天最多 40 个，多了就是刷屏');
});

test('问了但没冒（回「没有」/重复）：记一笔，别每个周期都重问', () => {
  const t0 = Date.UTC(2026, 10, 24, 2, 0);
  let imp = noteTry(createImpulses(), t0);
  assert.equal(dueThought(state(), imp, t0 + MIN_GAP_MS - 1, { topicAt: t0 }), false);
  assert.equal(dueThought(state(), imp, t0 + MIN_GAP_MS, { topicAt: t0 }), true);
});

test('平复要等够久、也要情绪真的下去', () => {
  const t0 = Date.UTC(2026, 10, 24, 10, 0);
  const imp = applyThought(createImpulses(), '他让我难受，我不理他了', t0, { v: 0.3 });
  assert.equal(dueSettle(imp, state({ intensity: 0.8 }), t0 + SETTLE_MIN_MS - 1), null, '劲儿还没过');
  assert.equal(dueSettle(imp, state({ intensity: 0.8 }), t0 + SETTLE_MIN_MS), null, '还上头就不问「现在怎么想」');
  const open = dueSettle(imp, state({ intensity: 0.05 }), t0 + SETTLE_MIN_MS);
  assert.ok(open, '情绪下去了，该回头看一眼');
  assert.equal(open.text, '他让我难受，我不理他了');
});

test('回头看也有额度：一天最多 20 次', () => {
  const t0 = Date.UTC(2026, 10, 24, 2, 0);
  let imp = createImpulses();
  for (let i = 0; i < SETTLE_PER_DAY + 3; i += 1) {
    imp = applyThought(imp, `念头 ${i}`, t0 + i * MIN_GAP_MS, { v: 0.3 });
    imp = applySettle(imp, t0 + i * MIN_GAP_MS, '', t0 + i * MIN_GAP_MS + 5 * MIN);
  }
  assert.equal(settledToday(imp, t0 + 6 * HOUR), SETTLE_PER_DAY + 3);
  // 再多冒一个、而且到时间了：额度用完了也不问。
  imp = applyThought(imp, '还有一个没回头看', t0 + 5 * HOUR, { v: 0.3 });
  assert.equal(dueSettle(imp, state(), t0 + 6 * HOUR), null, '额度用完就不再问');
});

test('「没变」也要落一行：不然每十分钟问一遍同一句', () => {
  const t0 = Date.UTC(2026, 10, 24, 10, 0);
  const imp = applyThought(createImpulses(), '算了', t0, { v: 0.3 });
  const next = applySettle(imp, t0, parseSettle('没变'), t0 + HOUR);
  assert.equal(next.lines[0].settled.text, '', '没变存空串');
  assert.equal(dueSettle(next, state(), t0 + 2 * HOUR), null, '问过了就不再问');
  assert.doesNotMatch(renderImpulses(next, t0 + 2 * HOUR), /没变/, '空的不显示成一句想法');
});

test('前后两种想法都摆出来：这是她自己的矛盾，不是编的', () => {
  const t0 = Date.UTC(2026, 10, 24, 10, 0);
  let imp = applyThought(createImpulses(), '他让我伤心了，我不理他了', t0, { v: 0.25 });
  assert.match(renderImpulses(imp, t0 + 30 * MIN), /他让我伤心了/);
  imp = applySettle(imp, t0, '其实他也不是故意的', t0 + HOUR);
  const line = renderImpulses(imp, t0 + 2 * HOUR);
  assert.match(line, /他让我伤心了/, '先前的想法');
  assert.match(line, /其实他也不是故意的/, '后来的想法');
});

test('念头会过期：三小时前的嘀咕不该还被她当成「刚冒出来的」', () => {
  const t0 = Date.UTC(2026, 10, 24, 10, 0);
  const imp = applyThought(createImpulses(), '好想他', t0, { v: 0.8 });
  assert.match(renderImpulses(imp, t0 + TTL_MS - 1), /好想他/);
  assert.equal(renderImpulses(imp, t0 + TTL_MS), '');
});

test('他晾着她：等太久也会冒念头，而且允许冒小坏心思', () => {
  const t = Date.UTC(2026, 10, 24, 10, 0);
  const imp = createImpulses();
  assert.equal(dueThought(state(), imp, t, { waiting: { unanswered: 1 } }), true, '她说了没人接，就会想');
  const p = thoughtPrompt(state({ mood: 0.4 }), { now: t, waiting: { unanswered: 2, minutes: 75, lastText: '喂，人呢' } });
  assert.match(p, /喂，人呢/, '她等的是哪句');
  assert.match(p, /75 分钟/);
  assert.match(p, /小坏心思/);
  assert.match(p, /不想理他|让他也急一急/, '比如冷着他、让他急');
});

test('联想具体化：想吃、想给他买、想做什么', () => {
  const t = Date.UTC(2026, 10, 24, 10, 0);
  const p = thoughtPrompt(state(), { now: t, topic: { his: '楼下新开了家手抓饼', hers: '' } });
  assert.match(p, /手抓饼/);
  assert.match(p, /想给他买/, '看到吃的会想到给他买一份');
  assert.match(p, /想吃/, '也可能自己馋了');
  assert.match(p, /想做的小事/, '念头可以是一个想做的事，不只是心里的一句话');
});

test('提示词：带上刚才聊的事，允许跟她自己之前的想法反着来', () => {
  const t = Date.UTC(2026, 10, 24, 10, 0);
  const topic = { his: '今天跑步好累', hers: '累了就回来躺着', at: t };
  const p = thoughtPrompt(state({ intensity: 0.8, mood: 0.2, label: '低落', v: 0.25 }), {
    now: t, topic, oldThoughts: ['其实他也没那么坏'],
  });
  assert.match(p, /心情有点低/);
  assert.match(p, /他：今天跑步好累/, '话题是他的真话');
  assert.match(p, /你：累了就回来躺着/);
  assert.match(p, /联想/, '这是联想，不是总结');
  assert.match(p, /特征/, '从一个特征想到另一件事');
  assert.match(p, /其实他也没那么坏/, '旧念头给她看');
  assert.match(p, /反着来/, '允许跟自己冲突');
  assert.match(p, /不超过 30 字/);
  assert.match(p, /往坏处想/);
  assert.doesNotMatch(p, /随机/, '不许让她随机编');
  assert.match(settlePrompt({ at: t, text: '算了' }, state(), t + HOUR), /回头看/);
});

test('话题从历史里取：剥掉括号动作和图片注脚，太久以前的不算', () => {
  const t = Date.UTC(2026, 10, 24, 10, 0);
  const history = [
    { role: 'user', text: '（偷看裙底）[图片]', at: t - 10 * MIN },
    { role: 'assistant', text: '喂，收回去', at: t - 9 * MIN },
    { role: 'user', text: '今天跑步好累', at: t - 5 * MIN },
    { role: 'assistant', text: '累了就回来躺着', at: t - 4 * MIN },
  ];
  const a = topicOf(history, { now: t });
  assert.equal(a.his, '今天跑步好累');
  assert.equal(a.hers, '累了就回来躺着');
  assert.equal(topicOf(history, { now: t + 3 * HOUR }).his, '', '三小时后不算「刚才」');
  assert.equal(topicOf([], { now: t }).his, '');
});

test('念头重复就不记：多起来了也不能来回炒同一句', () => {
  const t0 = Date.UTC(2026, 10, 24, 10, 0);
  const imp = applyThought(createImpulses(), '好想黏着他', t0, { v: 0.8 });
  assert.equal(repeatThought(imp, '好想黏着他'), true);
  assert.equal(repeatThought(imp, '好想黏着他啊'), true, '去掉标点几乎一样');
  assert.equal(repeatThought(imp, '今天不想说话'), false);
});

test('解析：只收一句短话，引号去掉，「没有」= 这次不冒', () => {
  assert.equal(parseThought('「算了，不想理他」'), '算了，不想理他');
  assert.equal(parseThought('没有。'), '');
  assert.equal(parseThought(''), '');
  assert.equal(parseThought('啊'.repeat(50)).length, 30, '太长就截断，别把一段话塞进念头');
  assert.equal(parseSettle('还是那样'), '');
  assert.equal(parseSettle('其实还好'), '其实还好');
});

test('一条念头只平复一次（重复 applySettle 不覆盖）', () => {
  const t0 = Date.UTC(2026, 10, 24, 10, 0);
  let imp = applyThought(createImpulses(), '算了', t0, { v: 0.3 });
  imp = applySettle(imp, t0, '还好', t0 + HOUR);
  imp = applySettle(imp, t0, '另一句', t0 + 2 * HOUR);
  assert.equal(imp.lines[0].settled.text, '还好');
});
