// 行为账本：只记她怎么说的；周报的数字要能对上账。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBehavior, entryOf, fileOf, looksLikeRefusal, readBehavior, statsText, weekStats, WEEK_MS } from '../src/behavior-log.js';
import { composePrompt } from '../src/insights.js';
import { createCard, remember } from '../src/memory/card.js';

const T0 = Date.UTC(2026, 0, 1, 12);

test('疑似拒绝：只认短句，长句里的「不」不算', () => {
  assert.equal(looksLikeRefusal('不行'), true);
  assert.equal(looksLikeRefusal('算了'), true);
  assert.equal(looksLikeRefusal('我不想聊这个'), true);
  assert.equal(looksLikeRefusal('不行，但我们可以换个方式试试，你觉得呢'), false, '长句是解释，不是拒绝');
  assert.equal(looksLikeRefusal('今天天气不错'), false);
  assert.equal(looksLikeRefusal(''), false);
});

test('记账：一行一轮，只留她自己的行为，不留他说的内容', () => {
  const e = entryOf({ at: T0, parts: 2, chars: 18, situations: ['night', 'night'], said: '嗯嗯我也觉得', stuck: true });
  assert.deepEqual(e, {
    at: T0, parts: 2, chars: 18, situations: ['night'], stuck: true, refused: false, open: '嗯嗯我也觉得'.slice(0, 6),
  });
  assert.equal(JSON.stringify(e).includes('他说'), false);
});

test('账本：跨月能一起读，坏行跳过，不毁掉整周', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-blog-'));
  appendBehavior(dir, entryOf({ at: Date.UTC(2026, 0, 31, 20), parts: 1, chars: 5, said: '嗯' }));
  appendBehavior(dir, entryOf({ at: Date.UTC(2026, 1, 1, 9), parts: 2, chars: 9, said: '好啦好啦' }));
  // 手动塞一行坏的：真实世界里文件会被别的编辑器碰坏。
  writeFileSync(fileOf(dir, Date.UTC(2026, 1, 1)), '{这不是 json}\n', { flag: 'a' });

  const got = readBehavior(dir, { from: Date.UTC(2026, 0, 30), to: Date.UTC(2026, 1, 2) });
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((e) => e.chars), [5, 9]);
});

test('周统计：数字和账本能对上（这就是验收要的那句）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-week-'));
  // 12 次在打转，其余正常：报出来必须正好是 12。
  for (let i = 0; i < 12; i++) {
    appendBehavior(dir, entryOf({ at: T0 + i * 60000, parts: 1, chars: 4, said: '嗯我在', stuck: true }));
  }
  for (let i = 0; i < 8; i++) {
    appendBehavior(dir, entryOf({ at: T0 + (20 + i) * 60000, parts: 2, chars: 20, said: '今天这样挺好的', stuck: false }));
  }
  const s = weekStats(readBehavior(dir, { from: T0 - WEEK_MS, to: T0 + WEEK_MS }));
  assert.equal(s.turns, 20);
  assert.equal(s.stuck, 12);
  assert.equal(s.topOpen.text, '嗯我在');
  assert.equal(s.topOpen.n, 12);

  const text = statsText(s);
  assert.match(text, /20 轮/);
  assert.match(text, /12 次在连着几条里绕同一件事/);
  assert.match(text, /「嗯我在」，用了 12 次/);
});

test('同一句话少于三次：不算「最常说」，那是巧合', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-week2-'));
  for (let i = 0; i < 2; i++) appendBehavior(dir, entryOf({ at: T0 + i, parts: 1, chars: 3, said: '哈哈' }));
  assert.equal(weekStats(readBehavior(dir, { from: 0, to: T0 + 10 })).topOpen, null);
});

test('周自述：有账本就把数字喂进去，没有就跟以前一样', () => {
  let card = remember(createCard(T0), '他说他喜欢猫', { now: T0, owner: true });
  const plain = composePrompt(card, { now: T0 });
  assert.doesNotMatch(plain, /说话记录/);

  const withStats = composePrompt(card, { now: T0, extra: '- 这一周说了 20 轮' });
  assert.match(withStats, /说话记录|这一周说了 20 轮/);
  assert.match(withStats, /尽量用上它/, '得告诉她数字该怎么用，不然她只会写成「我要更用心」');
});
