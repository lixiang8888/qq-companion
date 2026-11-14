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

test('没有指令的普通句子原样返回', () => {
  assert.deepEqual(parseActions('今天好累啊'), { text: '今天好累啊', stickers: [], searches: [] });
});
