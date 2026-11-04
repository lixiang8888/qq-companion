// 记忆卡：重要度、每天一档的模糊、补跑、永不遗忘的锚点、注入上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, classify, createCard, forget, maintain, remember, render, restore, scoreMemory, stats, targetClarity, undoSupersede } from '../src/memory/card.js';

const T0 = Date.UTC(2026, 0, 1);
const rank = { trace: 0, fuzzy: 1, clear: 2, vivid: 3 };
const withImportance = (card, value) => { card.records[0].importance = value; return card; };

test('重要度：主人私聊 > 群里 > 普通；第一次额外加分', () => {
  const plain = scoreMemory('今天下雨了').score;
  const group = scoreMemory('今天下雨了', { owner: true, inGroup: true }).score;
  const priv = scoreMemory('今天下雨了', { owner: true }).score;
  assert.ok(priv > group && group > plain);
  assert.ok(scoreMemory('第一次见到你').score > scoreMemory('见到你').score);
  assert.ok(scoreMemory('嗯').score < 10, '太短的要扣分');
});

test('记住：同一条不重复存，再提到就回到清晰', () => {
  let card = withImportance(remember(createCard(T0), '他喜欢猫', { now: T0 }), 60);
  card = maintain(card, T0 + 20 * DAY_MS);
  assert.ok(rank[card.records[0].clarity] < 3, '放久了会模糊');
  card = remember(card, '他喜欢猫', { now: T0 + 20 * DAY_MS });
  assert.equal(card.records.length, 1);
  assert.equal(card.records[0].clarity, 'vivid');
  assert.equal(card.records[0].recallCount, 1);
});

test('锚点：主人的第一句话被置顶，永远清晰', () => {
  let card = createCard(T0);
  card = remember(card, '第一次和你说话', { now: T0, owner: true });
  const rec = card.records[0];
  assert.equal(rec.first, true);
  assert.equal(rec.pinned, true);
  assert.equal(rec.importance, 100);
  card = maintain(card, T0 + 200 * DAY_MS);
  assert.equal(card.records[0].clarity, 'vivid');
});

test('模糊：一天最多降一档，停机后按天补跑', () => {
  const card = withImportance(remember(createCard(T0), '随手提过的一件小事', { now: T0 }), 30);
  let prev = 3;
  for (let d = 1; d <= 6; d++) {
    const next = maintain(card, T0 + d * DAY_MS);
    const now = rank[next.records[0]?.clarity ?? 'trace'];
    assert.ok(prev - now <= 1, `第 ${d} 天降了 ${prev - now} 档`);
    prev = now;
  }
  assert.ok(prev < 3, '六天之后应该模糊了');
});

test('主人重要记忆：不会跌到只剩印象', () => {
  let card = createCard(T0);
  card = remember(card, '第一次见', { now: T0, owner: true });
  card = remember(card, '他跟我说了家里的事', { now: T0 + 1, owner: true });
  card.records[1].importance = 70;
  const late = maintain(card, T0 + 400 * DAY_MS);
  assert.ok(['vivid', 'clear'].includes(late.records[1].clarity), `实际 ${late.records[1].clarity}`);
  assert.equal(targetClarity(card.records[1], T0 + 400 * DAY_MS), 'clear');
});

test('遗忘：不重要又很久的，被标记遗忘而不是立刻消失（可找回）', () => {
  let card = remember(createCard(T0), '嗯', { now: T0 });
  card = maintain(card, T0 + 60 * DAY_MS);
  assert.equal(card.records.length, 1, '软删除：记录还在，等着被找回');
  assert.equal(card.stats.forgotten, 1);
  assert.equal(card.records[0].forgottenAt, T0 + 60 * DAY_MS);
  assert.equal(stats(card).total, 0, '但不再算「她还记得的」');
  // 90 天保留期一过才真删
  card = maintain(card, T0 + 60 * DAY_MS + 91 * DAY_MS);
  assert.equal(card.records.length, 0);
  assert.equal(card.stats.purged, 1);
});

test('注入：初次相遇排最前，总量卡死', () => {
  let card = createCard(T0);
  card = remember(card, '第一次见面，在群里', { now: T0, owner: true });
  for (let i = 0; i < 30; i++) card = remember(card, `第 ${i} 件小事，有点长的一句描述，用来占位`, { now: T0 + i });
  const text = render(card, { now: T0 + 30, maxChars: 300 });
  assert.ok(text.length < 420, `实际 ${text.length}`);
  assert.match(text, /第一次见面/);
  assert.match(text, /不是他刚说的/);
});

test('注入：没有记忆时不注入空块', () => {
  assert.equal(render(createCard(T0), { now: T0 }), '');
});

test('安全阀：条数超上限时淘汰最不重要、最旧的，锚点不动', () => {
  let card = createCard(T0);
  card = remember(card, '第一次见面', { now: T0, owner: true }); // 锚点
  card.records[0].importance = 100;
  for (let i = 0; i < 5; i++) {
    card = remember(card, `第 ${i} 件普通小事，稍微长一点`, { now: T0 + i, maxRecords: 3 });
  }
  assert.equal(card.records.length, 3);
  assert.ok(card.records.some((r) => r.first), '锚点不能被淘汰');
  assert.ok(card.stats.evicted >= 3, `实际淘汰 ${card.stats.evicted}`);
});

test('注入：身份类记忆永远排在最前，哪怕是半年以前说的', () => {
  let card = createCard(T0);
  card = remember(card, '第一次见面', { now: T0, owner: true }); // 锚点占第一行
  card = remember(card, '我对花生过敏', { now: T0, owner: true });
  for (let i = 0; i < 5; i++) {
    card = remember(card, `今天第 ${i} 件闲事，写长一点才好入库`, { now: T0 + (i + 1) * 20 * DAY_MS, owner: true });
  }
  const lines = render(card, { now: T0 + 200 * DAY_MS, maxChars: 2200, query: '今天' }).split('\n');
  assert.match(lines[2], /花生/, `前三行是 ${JSON.stringify(lines.slice(0, 4))}`);
});

test('遗忘可逆：忘了不注入，但还在库里，找回就回来', () => {
  let card = remember(createCard(T0), '他讨厌香菜', { now: T0, owner: true });
  const id = card.records[0].id;
  card = forget(card, id, T0);
  assert.equal(render(card, { now: T0 }), '', '忘了就不该再注入');
  assert.equal(card.records.length, 1, '但记录还在（可找回）');
  assert.equal(stats(card).archived, 1);
  card = restore(card, id);
  assert.match(render(card, { now: T0 }), /香菜/, '找回之后又能想起来');
  assert.equal(stats(card).archived, 0);
});

test('回忆带当时的感受：难受和高兴各一句，中间地带不加', () => {
  let card = createCard(T0);
  card = remember(card, '我妈住院了', { now: T0, owner: true, mood: { v: 0.2, a: 0.6 } });
  card = remember(card, '他夸我可爱', { now: T0 + 1, owner: true, mood: { v: 0.9, a: 0.5 } });
  card = remember(card, '今天吃了面', { now: T0 + 2, owner: true, mood: { v: 0.5, a: 0.3 } });
  const text = render(card, { now: T0, maxChars: 2000 });
  const line = (t) => text.split('\n').find((l) => l.includes(t)) || '';
  assert.match(line('我妈住院了'), /那会儿我挺难受/);
  assert.match(line('他夸我可爱'), /那会儿我挺高兴/);
  assert.doesNotMatch(line('今天吃了面'), /那会儿/, '心情一般就不占字数');
});

test('统计：分档计数', () => {
  let card = createCard(T0);
  card = remember(card, '一二三四五六', { now: T0 });
  card = remember(card, '七八九十十一', { now: T0 });
  card = maintain(card, T0 + DAY_MS);
  const s = stats(card);
  assert.equal(s.total, 2);
  assert.equal(s.forgotten, 0);
});

// 分类存在的理由：400 天、3000 条封顶之后，「我对花生过敏」会被日常闲聊挤出去。
test('分类：关于他是谁 / 发生过什么 / 日常闲话', () => {
  assert.equal(classify('我养了一只猫叫团子'), 'identity');
  assert.equal(classify('我对花生过敏'), 'identity');
  assert.equal(classify('我下个月要考试'), 'event');
  assert.equal(classify('今天好累'), 'chatter');
});

test('身份类记忆不会被闲聊挤掉', () => {
  let card = createCard(T0);
  card = remember(card, '我对花生过敏', { now: T0, owner: true });
  for (let i = 0; i < 20; i++) {
    card = remember(card, `今天第 ${i} 件闲事，写长一点好入库`, { now: T0 + i * 1000, owner: true, maxRecords: 3 });
  }
  assert.ok(card.records.some((r) => r.text === '我对花生过敏'), '身份类不能先被淘汰');
  assert.equal(card.records.length, 3);
});

test('身份类记忆放很久也不会只剩印象', () => {
  let card = createCard(T0);
  card = remember(card, '我妈住在杭州', { now: T0, owner: true });
  card = maintain(card, T0 + 120 * DAY_MS);
  const rec = card.records.find((r) => r.text === '我妈住在杭州');
  assert.ok(rank[rec.clarity] >= rank.clear, `实际 ${rec.clarity}`);
});
