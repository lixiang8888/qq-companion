// 2026-11-23：想起也算复习（有冷却、有封顶），以及旧事多起来时的取舍。
//   · 被注入 ≠ 复习 的旧行为：天天出现在上下文里，照样按天淡。
//   · 现在：每轮真的被想起来的那几条，7 天记一次信用，封顶 6 次。
//   · 轮换位：值得/情绪重但好久没出现的，隔一阵回来一次。
//   · 闲话滚动上限：旧事太多时先淘汰闲话，身份/事件/高热/复习过的不动。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLARITY_LABEL, MAX_CHATTER, PROMPT_CREDIT_MAX, RESURFACE_GAP_MS, createCard, notePrompted, remember,
  render, resurfaceCandidate, reviewCredit, selectForPrompt, targetClarity,
} from '../src/memory/card.js';

const DAY = 86400e3;
const T0 = Date.UTC(2026, 0, 1);
const cardOf = (records) => ({ ...createCard(T0), records });
const rec = (over = {}) => ({
  id: over.id || `m_${Math.random().toString(36).slice(2, 8)}`,
  text: over.text || '一条记忆',
  kind: 'chatter', source: 'said', importance: 50, clarity: 'clear',
  createdAt: T0, lastSeenAt: T0, recallCount: 0, ...over,
});

test('想起来才算复习：7 天内只记一次，之后才再加', () => {
  let card = cardOf([rec({ id: 'a' })]);
  // 第一次被想起来：记一次
  card = notePrompted(card, ['a'], T0 + DAY);
  assert.equal(card.records[0].promptedCount, 1);
  // 三天后再被想起来：时间更新，但不算第二次复习（冷却）
  card = notePrompted(card, ['a'], T0 + DAY + 3 * DAY);
  assert.equal(card.records[0].promptedCount, 1);
  assert.equal(card.records[0].lastPromptedAt, T0 + DAY + 3 * DAY);
  // 过了 7 天：再算一次
  card = notePrompted(card, ['a'], T0 + DAY + 8 * DAY);
  assert.equal(card.records[0].promptedCount, 2);
  // 没被选中的记录不动
  assert.equal(card.records[0].recallCount, 0);
});

test('复习信用有封顶：被想起来再多次也只算 6 次（+3 信用 → 目标档 +6）', () => {
  const many = rec({ promptedCount: 100 });
  assert.equal(reviewCredit(many), PROMPT_CREDIT_MAX * 0.5);
  // 被再说一遍（他重提）叠加在同一条上
  assert.equal(reviewCredit(rec({ promptedCount: 4, recallCount: 2 })), 2 + 2);
});

test('常被想起的事真的更清楚：复习信用会抬高目标档位', () => {
  const fresh = { createdAt: T0, lastSeenAt: T0 };
  const plain = rec({ ...fresh, importance: 45 });
  const reviewed = rec({ ...fresh, importance: 45, promptedCount: PROMPT_CREDIT_MAX });
  assert.equal(targetClarity(plain, T0), 'clear');
  assert.equal(targetClarity(reviewed, T0), 'vivid');
});

test('被遗忘的记录不会因为被"想起"而复活（注入本来就不含它）', () => {
  let card = cardOf([rec({ id: 'a', forgottenAt: T0 })]);
  const next = notePrompted(card, ['a'], T0 + DAY);
  assert.equal(next, null, '没有值得存的改动');
});

test('selectForPrompt 返回的 picks 就是文本里那几条，且不超预算', () => {
  let card = createCard(T0);
  for (let i = 0; i < 30; i++) card = remember(card, `第 ${i} 条要记的事，长度差不多`, { now: T0 + i });
  const { text, lines, picks } = selectForPrompt(card, { now: T0 + 1000, maxChars: 220 });
  assert.ok(text.length <= 220 + 80, '正文只有那几行，头尾固定字样另算');
  assert.ok(lines.length > 0 && picks.length === lines.length);
  for (const r of picks) assert.ok(text.includes(r.text), '选中的必须真的写进文本');
});

test('轮换位：重要但好久没出现的旧事，会隔一阵回到她眼前', () => {
  const old = rec({
    id: 'old', text: '他答应过以后每年陪我去看一次海', kind: 'event',
    importance: 80, clarity: 'fuzzy', createdAt: T0 - 30 * DAY, lastSeenAt: T0 - 30 * DAY,
  });
  assert.equal(resurfaceCandidate(cardOf([old]), { now: T0 })?.id, 'old', '值得的旧事是轮换候选');
  // 最近刚出现过：不轮换
  assert.equal(resurfaceCandidate(cardOf([{ ...old, lastPromptedAt: T0 - DAY }]), { now: T0 }), null);
  // 而且它真的挤得进这一轮的注入预算（排在普通按价值的前面）
  const fresh = Array.from({ length: 40 }, (_, i) => rec({
    id: `f${i}`, text: `今天的小事 ${i}`, clarity: 'vivid', createdAt: T0 - i, lastSeenAt: T0 - i,
  }));
  const { picks } = selectForPrompt(cardOf([old, ...fresh]), { now: T0, maxChars: 200 });
  assert.ok(picks.some((r) => r.id === 'old'), '旧事该挤进 200 字预算');
});

test('轮换位只给值得的：不重要的旧闲话不给它留位置，情绪重的算值得', () => {
  const junk = rec({ id: 'junk', text: '很久以前的一条闲聊', importance: 12, createdAt: T0 - 30 * DAY, lastSeenAt: T0 - 30 * DAY });
  assert.equal(resurfaceCandidate(cardOf([junk]), { now: T0 }), null);
  const hot = rec({ id: 'hot', text: '那天他哭得很厉害', heat: 0.9, importance: 30, createdAt: T0 - 30 * DAY, lastSeenAt: T0 - 30 * DAY });
  assert.equal(resurfaceCandidate(cardOf([hot]), { now: T0 })?.id, 'hot');
});

test('闲话滚动上限：旧事太多时先淘汰闲话，身份/高热/复习过的不动', () => {
  const chatter = Array.from({ length: MAX_CHATTER }, (_, i) => rec({
    id: `c${i}`, text: `闲聊 ${i}`, importance: 10 + (i % 3), createdAt: T0 - (MAX_CHATTER - i) * 1000, lastSeenAt: T0 - (MAX_CHATTER - i) * 1000,
  }));
  const identity = rec({ id: 'id1', text: '他叫小许', kind: 'identity', importance: 70 });
  const hot = rec({ id: 'hot', text: '那天他哭得很厉害', heat: 0.9, importance: 30 });
  const said = rec({ id: 'said', text: '他重提过的事', recallCount: 2, importance: 12 });
  const card = cardOf([...chatter, identity, hot, said]);
  const next = remember(card, '又一条新的闲聊', { now: T0 });
  const ids = new Set(next.records.map((r) => r.id));
  assert.ok(ids.has('id1') && ids.has('hot') && ids.has('said'), '该保护的一条都不能少');
  // 只数"可以被淘汰的闲话"：情绪重的、被重提过的另算，不占这个额度。
  const plain = next.records.filter((r) => r.kind === 'chatter' && !r.pinned
    && !(Number(r.heat) >= 0.6) && !(Number(r.recallCount) > 0));
  assert.ok(plain.length <= MAX_CHATTER, '闲话被压回上限');
  assert.ok((next.stats.evicted || 0) >= 1, '淘汰了闲话');
});

test('轮换常量没被写死反：7 天', () => {
  assert.equal(RESURFACE_GAP_MS, 7 * DAY);
  assert.equal(CLARITY_LABEL.clear, '清楚');
});

