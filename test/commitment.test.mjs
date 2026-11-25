// 她说的话要落回状态：去睡了就真的睡、答应过的事有账、没做到要认。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RHYTHM_DEFAULTS, advanceRhythm, applyClaim, createRhythm, debtForMisses, duePromises,
  latePromises, missedEmotion, nextWakeAt, parsePromise, parseRhythmClaim, promiseLoop,
  rhythmLine, wakeRhythm,
} from '../src/commitment.js';
import { addLoop, createIntents, markDone } from '../src/intent.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const at = (h, m = 0, day = 1) => new Date(2026, 0, day, h, m, 0).getTime();

// ---- 睡 / 忙 ----

test('认得出「我要去睡了」，认不出「你去睡吧」', () => {
  assert.equal(parseRhythmClaim('晚安').state, 'asleep');
  assert.equal(parseRhythmClaim('我先睡了').state, 'asleep');
  assert.equal(parseRhythmClaim('困死了我要睡觉了').state, 'asleep');
  assert.equal(parseRhythmClaim('哈哈那我去睡了，你也早点').state, 'asleep');
  assert.equal(parseRhythmClaim('你去睡吧'), null, '催他睡不是她睡');
  assert.equal(parseRhythmClaim('你快去睡'), null);
  assert.equal(parseRhythmClaim('今天看了两章'), null);
});

test('认得出「我去忙了/等我一下」，但要她说自己', () => {
  assert.equal(parseRhythmClaim('我去吃饭了').state, 'away');
  assert.equal(parseRhythmClaim('等我一下，马上回来').state, 'away');
  assert.equal(parseRhythmClaim('你先吃吧'), null);
});

test('进睡：到下一次 7 点；7 点前睡算今天，7 点后算明天', () => {
  const early = at(2);
  assert.equal(applyClaim(createRhythm(), parseRhythmClaim('晚安'), early, RHYTHM_DEFAULTS).until, at(7));
  const late = at(23);
  assert.equal(applyClaim(createRhythm(), parseRhythmClaim('晚安'), late, RHYTHM_DEFAULTS).until, at(7, 0, 2));
  assert.equal(nextWakeAt(late), at(7, 0, 2));
});

test('进「不在」：默认 45 分钟；睡和忙是两个状态', () => {
  const rh = applyClaim(createRhythm(), parseRhythmClaim('我去洗澡了'), at(21), RHYTHM_DEFAULTS);
  assert.equal(rh.state, 'away');
  assert.equal(rh.until, at(21) + 45 * 60e3);
  assert.equal(typeof rh.claim, 'string');
});

test('他发消息把她叫醒；本来醒着就不会多此一举', () => {
  const asleep = applyClaim(createRhythm(), parseRhythmClaim('晚安'), at(23), RHYTHM_DEFAULTS);
  assert.equal(wakeRhythm(createRhythm(), at(23)), null);
  const woke = wakeRhythm(asleep, at(23, 30), { by: 'his message' });
  assert.equal(woke.state, 'awake');
  assert.equal(woke.wokeBy, 'his message');
  assert.equal(woke.until, 0);
});

test('到点自己醒：睡到早上 / 忙完那段时间过完；没到点不动', () => {
  const asleep = applyClaim(createRhythm(), parseRhythmClaim('晚安'), at(23), RHYTHM_DEFAULTS);
  assert.equal(advanceRhythm(asleep, at(23, 30)), null);
  const morning = advanceRhythm(asleep, at(8, 0, 2), RHYTHM_DEFAULTS);
  assert.equal(morning.state, 'awake');
  assert.equal(morning.wokeBy, 'timeout');
  const away = applyClaim(createRhythm(), parseRhythmClaim('我去吃饭'), at(12), RHYTHM_DEFAULTS);
  assert.equal(advanceRhythm(away, at(12, 30)), null);
  assert.equal(advanceRhythm(away, at(13)).state, 'awake');
});

test('注入那一行：睡着/不在/刚被吵醒/醒着各有各的说法', () => {
  const asleep = applyClaim(createRhythm(), parseRhythmClaim('晚安'), at(23), RHYTHM_DEFAULTS);
  assert.match(rhythmLine(asleep, at(23, 20)), /你现在是睡着的/);
  assert.match(rhythmLine(asleep, at(23, 20)), /回不回你自己定/);
  const woke = wakeRhythm(asleep, at(23, 40));
  assert.match(rhythmLine(woke, at(23, 50)), /刚被吵醒/);
  assert.equal(rhythmLine(woke, at(23, 50) + 20 * 60e3), '', '过了困劲就不提了');
  assert.equal(rhythmLine(createRhythm(), at(10)), '');
  const away = applyClaim(createRhythm(), parseRhythmClaim('我去吃饭'), at(12), RHYTHM_DEFAULTS);
  assert.match(rhythmLine(away, at(12, 10)), /这会儿不在/);
});

// ---- 承诺 ----

test('认得出她自己的承诺；他的承诺、问句都不算', () => {
  const p1 = parsePromise('回来给你讲那个结局', at(20));
  assert.equal(p1.claim, '回来给你讲那个结局');
  assert.equal(p1.dueAt, at(20) + 2 * HOUR);
  const p2 = parsePromise('明天跟你说个事', at(22));
  assert.equal(p2.dueAt, at(20, 0, 2), '明天 = 明天晚上 20:00');
  assert.equal(parsePromise('改天聊'), null, '太短、也不像一句完整的话');
  assert.equal(parsePromise('你答应过带我去的'), null, '他答应的，不是她的账');
  assert.equal(parsePromise('回来给你讲吗？'), null, '问句不算承诺');
  assert.equal(parsePromise('我答应你，下次一定'), null, '没有具体内容的「答应」不记');
});

test('承诺落成账：到点之前不催，到点进「该做了」，过宽限期就是没做到', () => {
  const now = at(20);
  const promise = parsePromise('回来给你讲结局', now);
  const loop = promiseLoop(promise, { now });
  assert.equal(loop.kind, 'promise');
  assert.equal(loop.dueAt, promise.dueAt);
  let st = addLoop(createIntents(), loop);
  assert.equal(duePromises(st, now + HOUR).length, 0, '还没到点');
  assert.equal(duePromises(st, now + 3 * HOUR).length, 1, '到点了，该兑现');
  assert.equal(latePromises(st, now + 3 * HOUR).length, 0, '宽限期内还不算没做到');
  assert.equal(latePromises(st, now + 3 * HOUR + DAY).length, 1, '过了宽限期 = 没做到');
});

test('做完的承诺不再催', () => {
  const now = at(20);
  const loop = promiseLoop(parsePromise('回来给你讲结局', now), { now });
  let st = addLoop(createIntents(), loop);
  st = markDone(st, loop.id, now + HOUR);
  assert.equal(duePromises(st, now + 3 * HOUR).length, 0);
  assert.equal(latePromises(st, now + 3 * HOUR + DAY).length, 0);
});

test('没做到给什么情绪：标签是亏欠，强度随件数涨（有上限）', () => {
  const one = missedEmotion(1);
  assert.equal(one.label, '亏欠');
  const two = missedEmotion(2);
  assert.ok(two.intensity > one.intensity);
  assert.ok(missedEmotion(9).intensity <= 1);
  assert.ok(debtForMisses(1) > 0);
  assert.ok(debtForMisses(9) <= 0.3, '欠着也不会一下压死');
});
