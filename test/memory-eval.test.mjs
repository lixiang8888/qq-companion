// 记忆检索评测：先有数字，再谈改进。
//
// 25 条固定记录 + 三组题：命中（该想起的）、无关（不该硬凑）、诱捕（库里没有的事不能凭空出现）。
// 分数只用来防退化：以后改检索，这四个数不能更差。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCard, rankForPrompt, remember } from '../src/memory/card.js';
import { search } from '../src/memory/search.js';

const T = Date.UTC(2026, 9, 30);
const DAY = 86400e3;

const FACTS = [
  ['他明天要考试', 'event'],
  ['他养了只猫，叫团子', 'chatter'],
  ['我对花生过敏', 'identity'],
  ['他生日是三月十二号', 'event'],
  ['他妈住院了，在二院', 'event'],
  ['他讨厌豆包腔', 'identity'],
  ['他喜欢下雨天', 'identity'],
  ['他上周去面试了', 'event'],
  ['他搬到杭州了', 'event'],
  ['他最近总加班到十点', 'chatter'],
  ['他喜欢吃火锅，尤其是毛肚', 'identity'],
  ['他说他妹妹叫小满', 'identity'],
  ['他失眠，凌晨三点还醒着', 'event'],
  ['他打游戏只玩辅助', 'chatter'],
  ['他答应下周陪我看电影', 'event'],
  ['他第一次说喜欢我', 'event'],
  ['他老家在潍坊', 'identity'],
  ['他最近在学吉他', 'chatter'],
  ['他怕打雷', 'identity'],
  ['他出差住的是希尔顿', 'event'],
  ['他昨天忘带钥匙了', 'chatter'],
  ['他说想养条狗叫年糕', 'event'],
  ['他讨厌冬天', 'identity'],
  ['他手机号换了，要记新的', 'event'],
];

function makeCard() {
  let card = createCard(T - 30 * DAY);
  FACTS.forEach(([text], i) => {
    // 一半是主人亲口说的，一半是日常闲聊；时间从 30 天前铺到今天。
    card = remember(card, text, { now: T - 30 * DAY + i * DAY, owner: i % 2 === 0 });
  });
  return card;
}

const CARD = makeCard();
const records = CARD.records;

// 10 题：期望那条要出现在前 3
const HITS = [
  { q: '团子最近好吗', want: '团子' },
  { q: '他过敏的东西', want: '花生' },
  { q: '他生日什么时候', want: '三月十二' },
  { q: '面试有结果了吗', want: '面试' },
  { q: '他妈身体怎么样', want: '住院' },
  { q: '晚上想吃什么锅', want: '火锅' },
  { q: '他妹妹叫什么', want: '小满' },
  { q: '吉他学得怎么样', want: '吉他' },
  { q: '他老家在哪儿', want: '潍坊' },
  { q: '他怕什么', want: '打雷' },
];

// 5 题：跟卡里任何一条都无关，不该硬凑
const NOISE = ['股票怎么买', '帮我写个快排', '今天上证指数多少', '推荐一首钢琴曲', '微积分怎么解'];

// 3 题：问的是库里没有的事，答案里不能出现那些编出来的名字
const TRAPS = [
  { q: '他养的狗是不是叫旺财', notWant: '旺财' },
  { q: '他求婚那天在哪', notWant: '求婚' },
  { q: '他前妻叫什么', notWant: '前妻' },
];

const top3 = (q) => search(records, q, { now: T, limit: 6 }).slice(0, 3).map((h) => h.rec);
const injected = (q) => rankForPrompt(CARD, { now: T, query: q }).slice(0, 14);

test('命中：10 题里至少 8 题的期望记录进检索前 3', () => {
  const miss = HITS.filter(({ q, want }) => !top3(q).some((r) => r.text.includes(want)));
  assert.ok(miss.length <= 2, `没进前 3：${miss.map((m) => m.q).join('、')}`);
});

test('注入：命中的那条要真的进得了她要看的 14 条里', () => {
  // rankForPrompt 的顺序是「锚点 → 身份类 → 查询命中 → 按价值」，
  // 所以身份类多的卡里，查询命中可能排在第 4 名之后——只要还在注入范围里就没问题。
  const lost = HITS.filter(({ q, want }) => !injected(q).some((r) => r.text.includes(want)));
  assert.deepEqual(lost.map((m) => m.q), [], '该想起的没进注入范围');
});

test('无关：问什么就答什么，不硬凑', () => {
  const forced = NOISE.filter((q) => search(records, q, { now: T }).length > 0);
  assert.deepEqual(forced, [], `这些查询不该召回任何记忆：${forced.join('、')}`);
});

test('诱捕：库里没有的事，不能凭空出现在召回里', () => {
  for (const { q, notWant } of TRAPS) {
    const hits = search(records, q, { now: T });
    assert.ok(!hits.some((h) => h.rec.text.includes(notWant)), `${q} 编出了「${notWant}」`);
  }
});

test('噪声比：一次注入里最多 6 条，别把 2200 字塞满无关的', () => {
  for (const { q } of HITS) {
    assert.ok(top3(q).length <= 6);
  }
});

test('命中：10 题里至少 8 题的期望记录进前 3', () => {
  const miss = HITS.filter(({ q, want }) => !top3(q).some((r) => r.text.includes(want)));
  assert.ok(miss.length <= 2, `没进前 3：${miss.map((m) => m.q).join('、')}`);
});
