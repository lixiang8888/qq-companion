// 读书后端：三个接口的契约、正文清洗、下一章怎么挑。不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BASE, cleanText, createNovel, isBored, noteRead, novelLine, planRead } from '../src/novel.js';

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

function client(routes, base) {
  const calls = [];
  const fetchImpl = async (href) => {
    calls.push(href);
    const path = new URL(href).pathname;
    if (!(path in routes)) return { ok: false, status: 404, json: async () => ({}) };
    return jsonResponse(routes[path](new URL(href)));
  };
  return { novel: createNovel({ base, fetchImpl }), calls };
}

test('书架：字段取对，空书架不是错误', async () => {
  const { novel } = client({
    '/getBookshelf': () => ({ data: [{ name: '斗破苍穹', author: '天蚕土豆', bookUrl: 'http://x/1', totalChapterNum: 1652, durChapterIndex: 3 }] }),
  });
  const shelf = await novel.shelf();
  assert.equal(shelf.length, 1);
  assert.equal(shelf[0].name, '斗破苍穹');
  assert.equal(shelf[0].total, 1652);
  assert.equal(shelf[0].lastIndex, 3);

  const empty = client({ '/getBookshelf': () => ({ isSuccess: false, errorMsg: '还没有添加小说' }) });
  // 「还没有添加小说」是正常状态，不该抛——她只是还没书读。
  assert.deepEqual(await empty.novel.shelf(), []);
  const blank = client({ '/getBookshelf': () => ({ data: [] }) });
  assert.deepEqual(await blank.novel.shelf(), []);
});

test('目录和正文：参数名是 url，正文传的是书的地址不是章节地址', async () => {
  const { novel, calls } = client({
    '/getChapterList': () => ({ data: [{ index: 0, title: '第一章 陨落的天才' }, { index: 1, title: '第二章 斗气大陆' }] }),
    '/getBookContent': () => ({ data: '正文' }),
  });
  const list = await novel.chapters('http://x/1');
  assert.equal(list.length, 2);
  assert.equal(list[1].title, '第二章 斗气大陆');
  await novel.chapter('http://x/1', 7);

  const chUrl = new URL(calls[0]);
  assert.equal(chUrl.pathname, '/getChapterList');
  assert.equal(chUrl.searchParams.get('url'), 'http://x/1');
  const bodyUrl = new URL(calls[1]);
  assert.equal(bodyUrl.searchParams.get('url'), 'http://x/1');
  assert.equal(bodyUrl.searchParams.get('index'), '7');
});

test('正文清洗：站点广告整行丢掉，行首全角缩进去掉', () => {
  const raw = [
    '　　大厅中，萧战以及三位长老正在交谈。',
    '小说尽在 顶点小说，请认准 www.xx.com',
    '　　「他来了。」',
    '   ',
    '　　更多章节请到 https://example.com 阅读',
  ].join('\n');
  const out = cleanText(raw);
  assert.equal(out, '大厅中，萧战以及三位长老正在交谈。\n「他来了。」');
  assert.ok(!out.includes('www.'));
});

test('正文：字数按洗过之后算（太短就是这条源坏了）', async () => {
  const { novel } = client({ '/getBookContent': () => ({ data: '　　第一句。\n小说尽在某某网\n　　第二句。' }) });
  const c = await novel.chapter('http://x/1', 0);
  assert.equal(c.text, '第一句。\n第二句。');
  assert.equal(c.chars, c.text.length);
});

test('挑下一章：接着上次往后；读到底从头再来', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ index: i, title: `第${i + 1}章 标题` }));
  assert.deepEqual(planRead(mk(10), {}).index, 0);
  assert.deepEqual(planRead(mk(10), { index: 3, lastNum: 4 }).index, 4);
  // 读完最后一章：回到第一章重读，标记 wrapped
  const done = planRead(mk(10), { index: 9, lastNum: 10 });
  assert.equal(done.index, 0);
  assert.equal(done.wrapped, true);
  // 空目录不抛
  assert.equal(planRead([], {}).index, 0);
});

test('目录有重复章：不会再读一遍同一章', () => {
  // 真实情况：有的书源把第 2 章列了两次
  const list = [
    { index: 0, title: '第1章 开始' },
    { index: 1, title: '第2章 出发' },
    { index: 2, title: '第2章 出发' },
    { index: 3, title: '第3章 到达' },
  ];
  const next = planRead(list, { index: 1, lastNum: 2, readTitles: ['第2章 出发', '第1章 开始'] });
  assert.equal(next.title, '第3章 到达', '跳过重复的那条，直接读到第 3 章');
  assert.equal(next.gap, 0);
});

test('目录缺章：跳过去，并且如实把缺的数量报出来', () => {
  // 真实情况：第 3 章后面直接是第 6 章
  const list = [
    { index: 0, title: '第1章 一' },
    { index: 1, title: '第2章 二' },
    { index: 2, title: '第3章 三' },
    { index: 3, title: '第6章 六' },
  ];
  const next = planRead(list, { index: 2, lastNum: 3, readTitles: ['第3章 三'] });
  assert.equal(next.title, '第6章 六');
  assert.equal(next.gap, 2, '3 之后是 6，中间缺了 4 和 5');
});

test('没有章号的书（番外/卷名）：退回按下标走，跳过读过的标题', () => {
  const list = [
    { index: 0, title: '序章' },
    { index: 1, title: '番外 一' },
    { index: 2, title: '番外 二' },
  ];
  const next = planRead(list, { index: 0, readTitles: ['序章'] });
  assert.equal(next.title, '番外 一');
});

test('后端没开：给一句人话，不是 TypeError', async () => {
  const novel = createNovel({ base: 'http://127.0.0.1:9', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => novel.shelf(), /ECONNREFUSED/);
});

test('默认地址就在本机转发的那个口上', () => {
  assert.equal(DEFAULT_BASE, 'http://127.0.0.1:1123');
});

// ---- 什么时候该看、看完怎么记 ----

const H = 3600e3;
const NOON = new Date(2026, 0, 1, 12, 0, 0).getTime();

test('无聊的判据：他安静够久、今天读得不多、心情还行', () => {
  const base = { now: NOON, lastUserAt: NOON - 3 * H, lastReadAt: NOON - 1 * H, readsToday: 0, mood: 0.6 };
  assert.equal(isBored(base), true);
  // 他两小时前刚说过话：还不算无聊
  assert.equal(isBored({ ...base, lastUserAt: NOON - 1 * H }), false);
  // 十分钟内刚读过：不在同一个心跳里连读
  assert.equal(isBored({ ...base, lastReadAt: NOON - 5 * 60e3 }), false);
  // 今天读够了（上限 80 章）
  assert.equal(isBored({ ...base, readsToday: 80 }), false);
  assert.equal(isBored({ ...base, readsToday: 79 }), true);
  // 心情太低：那会儿看书是躲，不是消遣
  assert.equal(isBored({ ...base, mood: 0.2 }), false);
  // 从没说过话 / 没书：都不读
  assert.equal(isBored({ ...base, lastUserAt: 0 }), false);
  assert.equal(isBored({ ...base, hasBook: false }), false);
});

test('读书进度：记下书、章节、章号、感想；换书就重新算', () => {
  const s = noteRead({}, { now: NOON, book: { bookUrl: 'http://x/1', name: '斗破苍穹' }, index: 3, title: '第4章 云岚宗', num: 4, thought: `  ${'想'.repeat(300)}  ` });
  assert.equal(s.bookName, '斗破苍穹');
  assert.equal(s.index, 3);
  assert.equal(s.at, NOON);
  assert.equal(s.lastNum, 4);
  assert.equal(s.thought.length, 120, '感想上限 120 字');
  assert.deepEqual(s.readTitles, ['第4章 云岚宗']);

  // 同一本书接着读：章号和标题都累积
  const again = noteRead(s, { now: NOON + 1, book: { bookUrl: 'http://x/1', name: '斗破苍穹' }, index: 4, title: '第5章 聚气散', num: 5 });
  assert.equal(again.bookName, '斗破苍穹');
  assert.equal(again.lastNum, 5);
  assert.deepEqual(again.readTitles.slice(0, 2), ['第5章 聚气散', '第4章 云岚宗']);

  // 换了本书：章号和读过的标题都清掉，从这本自己的第 1 章算
  const other = noteRead(again, { now: NOON + 2, book: { bookUrl: 'http://y/2', name: '遮天' }, index: 0, title: '第一章 星空中的青铜巨棺', num: 1 });
  assert.equal(other.bookName, '遮天');
  assert.equal(other.lastNum, 1);
  assert.deepEqual(other.readTitles, ['第一章 星空中的青铜巨棺']);
});

test('注入那一行：说清在看什么、看到哪、当时想什么', () => {
  const s = noteRead({}, { now: NOON, book: { bookUrl: 'http://x/1', name: '斗破苍穹' }, index: 2, title: '第三章', thought: '有点替他不值' });
  const line = novelLine(s, NOON + 2 * H);
  assert.match(line, /《斗破苍穹》/);
  assert.match(line, /第 3 章/);
  assert.match(line, /有点替他不值/);
  assert.match(line, /2 小时前/);
  // 没读过就一个字都不写
  assert.equal(novelLine({}, NOON), '');
  assert.equal(novelLine({ bookName: '' }, NOON), '');
});
