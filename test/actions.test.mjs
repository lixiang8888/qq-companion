// 她回复里的方括号指令：一条协议管「发表情」和「查东西」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActions } from '../src/actions.js';

test('表情：标记从文本里剔掉，他说到的应该是话', () => {
  const a = parseActions('不用猜了[表情:无语]');
  assert.equal(a.text, '不用猜了');
  assert.deepEqual(a.stickers, ['无语']);
  assert.deepEqual(a.searches, []);
});

test('查：可以有，也可以同时有表情', () => {
  const a = parseActions('[查:杭州明天天气][表情:思考]');
  assert.equal(a.text, '');
  assert.deepEqual(a.searches, ['杭州明天天气']);
  assert.deepEqual(a.stickers, ['思考']);
});

test('全角冒号、多空格也认', () => {
  assert.deepEqual(parseActions('[表情 ： 委屈]').stickers, ['委屈']);
  assert.deepEqual(parseActions('[查：杭州 天气]').searches, ['杭州 天气']);
});

test('不是指令的方括号不动它', () => {
  const raw = '这个[笑]不是指令';
  assert.equal(parseActions(raw).text, raw);
  assert.deepEqual(parseActions(raw).stickers, []);
  assert.deepEqual(parseActions('[]').stickers, [], '空的不算');
});

test('剔掉标记后不留下开头的标点', () => {
  assert.equal(parseActions('[表情:无语]，你继续').text, '你继续');
});

test('书：翻自己的书，和查/表情互不打架', () => {
  const toc = parseActions('[书:目录]');
  assert.deepEqual(toc.books, ['目录']);
  assert.equal(toc.text, '');
  const ch = parseActions('我记得那段[书:第12章]');
  assert.deepEqual(ch.books, ['第12章']);
  assert.equal(ch.text, '我记得那段');
  const mixed = parseActions('[表情:无语][查:天气][书:目录]');
  assert.deepEqual([mixed.stickers, mixed.searches, mixed.books], [['无语'], ['天气'], ['目录']]);
});

test('没有指令的普通句子原样返回', () => {
  assert.deepEqual(parseActions('今天好累啊'), { text: '今天好累啊', stickers: [], searches: [], books: [] });
});

test('不回：她主动选择这一轮不理，标记剔掉、文本为空', () => {
  const a = parseActions('[不回]');
  assert.equal(a.text, '');
  assert.equal(a.silent, true);
  assert.equal(a.deferMinutes, undefined);
});

test('晚点回：默认 20 分钟，带分钟数也认，夹在 5~360', () => {
  assert.equal(parseActions('[晚点回]').deferMinutes, 20);
  assert.equal(parseActions('[晚点回:90]').deferMinutes, 90);
  assert.equal(parseActions('[晚点回：1]').deferMinutes, 5, '太短的夹到 5 分钟');
  assert.equal(parseActions('[晚点回:999]').deferMinutes, 360, '太长的夹到 360');
  const mixed = parseActions('等我一下[晚点回:30]');
  assert.equal(mixed.text, '等我一下', '带话也行：先应一声，晚点再说');
  assert.equal(mixed.deferMinutes, 30);
});

test('没标记时返回形状不变（不凭空多出 silent/deferMinutes 键）', () => {
  const a = parseActions('今天好累');
  assert.deepEqual(Object.keys(a).sort(), ['books', 'searches', 'stickers', 'text']);
});
