// 读书后端：三个接口的契约、正文清洗、下一章怎么挑。不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BASE, cleanText, createNovel, nextChapter } from '../src/novel.js';

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

test('下一章：接着上次往后；读到底从头再来', () => {
  assert.deepEqual(nextChapter({ lastIndex: -1, total: 10 }), { index: 0, wrapped: false });
  assert.deepEqual(nextChapter({ lastIndex: 3, total: 10 }), { index: 4, wrapped: false });
  assert.deepEqual(nextChapter({ lastIndex: 9, total: 10 }), { index: 0, wrapped: true });
  // 一本新加的、还没读过、章数未知：都从 0 开始，不抛
  assert.deepEqual(nextChapter({ lastIndex: -1, total: 0 }), { index: 0, wrapped: false });
  assert.deepEqual(nextChapter({}), { index: 0, wrapped: false });
});

test('后端没开：给一句人话，不是 TypeError', async () => {
  const novel = createNovel({ base: 'http://127.0.0.1:9', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => novel.shelf(), /ECONNREFUSED/);
});

test('默认地址就在本机转发的那个口上', () => {
  assert.equal(DEFAULT_BASE, 'http://127.0.0.1:1123');
});
