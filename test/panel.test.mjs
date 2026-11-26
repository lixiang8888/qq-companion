// 自检面板：该显示的都在，注入的文本不能变成 HTML。
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderPanel } from '../src/panel.js';
import { applyDamage, initState } from '../src/affect/core.js';
import { createCard, remember } from '../src/memory/card.js';

const T0 = Date.UTC(2026, 0, 1);

test('转义：记忆里的标签不能变成真标签', () => {
  assert.equal(escapeHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;');
});

test('面板：状态、人格、记忆、运行都在一页里', () => {
  const state = applyDamage(initState(T0), 0.05, T0).state;
  const memory = remember(createCard(T0), '他喜欢猫，叫团子', { now: T0 });
  const html = renderPanel({ state, memory, gateway: 'connected', session: { size: 4, compactions: 1 }, persona: '小鲸鱼', now: T0 });

  assert.match(html, /<!doctype html>/);
  assert.match(html, /心情/);
  assert.match(html, /信任/);
  assert.match(html, /敏感|好斗|依恋/);
  assert.match(html, /团子/);
  assert.match(html, /共 1 条/);
  assert.match(html, /connected/);
  assert.match(html, /小鲸鱼/);
});

test('面板：她最近在玩哪款、每款进度都能对上账本', () => {
  const game = {
    last: { game: 'lightsout', title: '点灯', facts: '玩了 3 分钟，点了 12 下，这一局玩完了', label: '闷', at: T0 },
    library: {
      lightsout: { title: '点灯', wins: 1, at: T0 },
      g2048: { title: '2048', best: 1024, at: T0 },
    },
  };
  const html = renderPanel({ state: initState(T0), memory: createCard(T0), game, now: T0 });
  assert.match(html, /《点灯》/);
  assert.match(html, /玩了 3 分钟/);
  assert.match(html, /点灯（赢过 1 次）/);
  assert.match(html, /2048（最高 1024）/);
});

test('面板不能自动刷新：表单里有 token，刷新一下输入就没了', () => {
  const html = renderPanel({ state: initState(T0), memory: createCard(T0), now: T0 });
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.match(html, /刷新/);
});

test('面板不能自动刷新：表单里要粘 token，刷新一下输入就没了', () => {
  const html = renderPanel({ state: initState(T0), memory: createCard(T0), now: T0 });
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.match(html, /刷新/);
});

test('面板：体检一节把没配好的项标红', () => {
  const html = renderPanel({
    state: initState(T0),
    memory: createCard(T0),
    checks: [
      { ok: false, label: '主人 QQ', detail: '没填 → 她谁都不回' },
      { ok: true, label: '模型', detail: 'deepseek-official/x' },
    ],
    now: T0,
  });
  assert.match(html, /体检/);
  assert.match(html, /❌ 主人 QQ/);
  assert.match(html, /✅ 模型/);
});

test('面板：最近对话能看到谁说了什么，长句会截断', () => {
  const state = initState(T0);
  const long = '啊'.repeat(200);
  const html = renderPanel({
    state,
    memory: createCard(T0),
    history: [
      { role: 'user', text: '在吗', at: T0 },
      { role: 'assistant', text: long, at: T0 + 1000 },
    ],
    now: T0,
  });
  assert.match(html, /最近对话/);
  assert.match(html, /他 · /);
  assert.match(html, /在吗/);
  assert.match(html, /她 · /);
  assert.ok(!html.includes('啊'.repeat(200)), '长回复应截断，别把面板撑爆');
});

test('面板：恶意记忆不会被渲染成脚本', () => {
  const state = initState(T0);
  const memory = remember(createCard(T0), '<img src=x onerror=alert(1)>', { now: T0 });
  const html = renderPanel({ state, memory, now: T0 });
  assert.ok(!html.includes('<img src=x'), '原样输出了标签');
  assert.match(html, /&lt;img/);
});

test('面板：有快照时给回滚链接', () => {
  const state = initState(T0);
  state.self.snapshots = [{ at: T0, traits: { attachment: 0.5 }, narrative: '' }];
  const html = renderPanel({ state, memory: createCard(T0), now: T0 });
  assert.match(html, /回滚到/);
  assert.match(html, /rollback=/);
});

test('面板：能看出这一轮想起了哪几条', () => {
  const state = initState(T0);
  const html = renderPanel({
    state,
    memory: createCard(T0),
    recalls: [{ at: T0, query: '团子最近好吗', picks: ['他养了一只猫叫团子'] }],
    now: T0,
  });
  assert.match(html, /最近想起/);
  assert.match(html, /团子/);
});

test('面板：每条记忆都能置顶/忘记', () => {
  const memory = remember(createCard(T0), '他喜欢猫', { now: T0 });
  const html = renderPanel({ state: initState(T0), memory, now: T0 });
  assert.match(html, /\?pin=/);
  assert.match(html, /\?forget=/);
});

test('面板：她的房间——关机多久也写上（她唯一亲身经历过的虚空）', () => {
  const before = new Date(2026, 0, 1, 22, 14).getTime();
  const offMs = 9.77 * 3600e3;
  const html = renderPanel({
    state: initState(T0),
    memory: createCard(T0),
    alive: { before, bootAt: before + offMs, offMs },
    now: T0,
  });
  assert.match(html, /上次醒着/);
  assert.match(html, /9 小时 46 分/);

  const fresh = renderPanel({ state: initState(T0), memory: createCard(T0), now: T0 });
  assert.match(fresh, /还没有上一次的记录/, '没有记录时不能凭空编');
});

test('面板：空记忆/空人格也不崩', () => {
  const html = renderPanel({ state: initState(T0), memory: createCard(T0), now: T0 });
  assert.match(html, /记忆卡还是空的/);
  assert.match(html, /最近没变过/);
});

test('面板：她的房间——此刻在做什么、到几点', () => {
  const until = new Date(2026, 0, 1, 21, 40).getTime();
  const html = renderPanel({ state: initState(T0), memory: createCard(T0), life: { doing: '在收拾东西', until }, now: until - 60e3 });
  assert.match(html, /她的房间/);
  assert.match(html, /在收拾东西/);
  assert.match(html, /21:40/);
});

test('面板：没在做什么时给一句人话，不显示空白', () => {
  const html = renderPanel({ state: initState(T0), memory: createCard(T0), life: { doing: '', until: 0 }, now: T0 });
  assert.match(html, /没在做什么/);
});

test('面板：日记照转义渲染，脚本不会变成标签', () => {
  const html = renderPanel({
    state: initState(T0),
    memory: createCard(T0),
    diaries: [{ date: '2026-10-28', text: '今天他一直在忙。\n\n<script>alert(1)</script>' }],
    now: T0,
  });
  assert.match(html, /2026-10-28/);
  assert.match(html, /今天他一直在忙/);
  assert.ok(!html.includes('<script>alert(1)'), '日记原样输出了标签');
  assert.match(html, /&lt;script&gt;/);
});

test('面板：还没写日记时说清楚', () => {
  const html = renderPanel({ state: initState(T0), memory: createCard(T0), diaries: [], now: T0 });
  assert.match(html, /还没写过日记/);
});

test('面板：读书那行带上对这本书的态度', () => {
  const html = renderPanel({
    state: initState(T0), memory: createCard(T0), now: T0,
    novel: { bookName: '斗破苍穹', bookUrl: 'http://x/1', index: 2, label: '闷', thought: '有点替他不值', books: { 'http://x/1': { attitude: -0.35 } } },
  });
  assert.match(html, /在读《斗破苍穹》第 3 章/);
  assert.match(html, /对这本：有点腻/);
  assert.match(html, /上次：闷/);
  // 态度还没占分量就一个字都不写
  const plain = renderPanel({
    state: initState(T0), memory: createCard(T0), now: T0,
    novel: { bookName: '遮天', bookUrl: 'http://y/2', index: 0, books: { 'http://y/2': { attitude: 0.05 } } },
  });
  assert.ok(!plain.includes('对这本'));
});

test('面板：她心里挂着的事（没说完的、答应没做到的、睡着、最冲的劲儿、开口判定）', () => {
  const state = initState(T0);
  const loop = (over) => ({
    id: 'lt_x', kind: 'tell', about: 'novel', text: '想跟他讲地蛋这名字', label: '《书》',
    createdAt: T0, dueAt: T0, expiresAt: T0 + 48 * 3600e3,
    spokenAt: 0, doneAt: 0, droppedAt: 0, missedAt: 0, expiredAt: 0, attempts: 0, lastTryAt: 0, target: null,
    ...over,
  });
  const html = renderPanel({
    state,
    memory: createCard(T0),
    intents: {
      loops: [
        loop(),
        loop({ id: 'lt_p', kind: 'promise', text: '回来给你讲那个结局', missedAt: T0 }),
      ],
    },
    rhythm: { state: 'asleep', since: T0, until: T0 + 8 * 3600e3, reason: '她说要去睡', claim: '晚安', wokeBy: '' },
    drives: { share: 0.6, miss: 0.2, proud: 0, curious: 0, tired: 0, sulk: 0 },
    proactive: { decisions: [{ at: T0, route: 'share', action: 'wait', reason: '他刚回来，这次先不说', loopText: '地蛋这名字' }] },
    now: T0,
  });
  assert.match(html, /她心里挂着的事/);
  assert.match(html, /想跟他讲地蛋这名字/);
  assert.match(html, /答应过但没做到/);
  assert.match(html, /现在睡着/);
  assert.match(html, /现在最冲的劲儿：有件事想跟他说/);
  assert.match(html, /最近几次开口判定/);
});

test('面板：她没账时也照实写「没有」，不编一句', () => {
  const html = renderPanel({ state: initState(T0), memory: createCard(T0), now: T0 });
  assert.match(html, /她手里没有还没完成的事/);
  assert.match(html, /她现在是醒着的/);
});
