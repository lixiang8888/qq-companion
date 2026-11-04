// 长跑：一年、每天几句，看它会不会失控。
//
// 这不是性能测试，是「上限有没有生效」的证明：历史、摘要、记忆条数、特质、关系，
// 跑满一年之后都应该停在各自该在的范围里，而且锚点还在。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, TRAITS, TRAIT_BASE } from '../src/affect/core.js';
import { createCompanion } from '../src/companion.js';
import { createLocalSession } from '../src/session.js';
import { createCard, maintain, remember, render, MAX_RECORDS } from '../src/memory/card.js';
import { sanitizeSecrets } from '../src/memory/sanitize.js';

const DAYS = Number(process.env.QQC_DAYS || 90); // 默认三个月；QQC_DAYS=365 跑满一年
const PER_DAY = 4;
const START = Date.UTC(2026, 0, 1);

test(`长跑 ${DAYS} 天：三处上限都守得住，锚点还在`, async () => {
  let clock = START;
  let affect = (await import('../src/affect/core.js')).initState(START);
  let card = createCard(START);
  let prompts = 0;

  const session = createLocalSession({
    system: '你是小鲸鱼',
    compactAt: 20,
    keepRecent: 8,
    now: () => clock,
    complete: async () => { prompts += 1; return '嗯，在呢'; },
  });

  const companion = createCompanion({
    load: () => affect,
    save: (s) => { affect = s; },
    session,
    ownerQQ: '42',
    now: () => clock,
    memoryBlock: async (msg) => {
      card = maintain(card, clock);
      card = remember(card, sanitizeSecrets(msg.text), { now: clock, owner: true, direct: true });
      return render(card, { now: clock, maxChars: 2200, query: msg.text });
    },
  });

  const lines = ['今天好累', '你在吗', '谢谢你陪我', '晚安', '我养了只猫叫团子', '今天加班到十点', '有点难过', '你真棒'];

  for (let d = 0; d < DAYS; d++) {
    for (let i = 0; i < PER_DAY; i++) {
      clock = START + d * DAY_MS + i * 3600e3;
      const text = `${lines[(d * PER_DAY + i) % lines.length]}（第 ${d} 天）`;
      await companion.handleMessage({ chatId: 'private:42', kind: 'private', userId: '42', text });
    }
  }

  const snap = session.snapshot();
  // 历史在两个边界之间锯齿：压缩后 9 条，涨到 21 条再压。上限是 compactAt+1。
  assert.ok(snap.history.length <= 21, `历史 ${snap.history.length} 条，超过 compactAt+1`);
  assert.ok(snap.summary.length <= 1200, `摘要 ${snap.summary.length} 字`);
  assert.ok(card.records.length <= MAX_RECORDS, `记忆 ${card.records.length} 条`);
  assert.ok(card.records.some((r) => r.first), '初次相遇的锚点不能被淘汰');

  for (const k of TRAITS) {
    const v = affect.self[k];
    assert.ok(Number.isFinite(v) && v >= 0.05 && v <= 0.95, `${k}=${v}`);
  }
  assert.ok(Math.abs(affect.self.sensitivity - TRAIT_BASE.sensitivity) < 0.3, '特质不该跑飞');
  assert.ok(affect.relation.trust >= 0 && affect.relation.trust <= 1);
  assert.ok(affect.relation.guard <= 0.7);
  assert.ok(affect.mood.v >= 0 && affect.mood.v <= 1);
  assert.ok(prompts > 0);
});
