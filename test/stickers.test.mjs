// 表情包：拉收藏、起名、按名字挑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NAME, mergeFavorites, namesLine, needNames, parseFavorites, pickSticker } from '../src/stickers.js';

const RAW = [
  { md5: 'm1', url: 'https://p.qpic.cn/a/0', desc: '' },
  { md5: 'm2', url: 'https://p.qpic.cn/b/0', desc: '' },
  { md5: '', url: '', desc: '坏的' },
];

test('解析收藏：没 url 的丢掉，desc 当名字', () => {
  const got = parseFavorites(RAW);
  assert.equal(got.length, 2);
  assert.equal(got[0].md5, 'm1');
  assert.equal(parseFavorites(null).length, 0);
});

test('合并：老名字要留住，不然每次同步都重新起名', () => {
  const prev = [{ md5: 'm1', url: 'https://p.qpic.cn/a/0', name: '无语' }];
  const merged = mergeFavorites(prev, parseFavorites(RAW));
  assert.equal(merged.find((s) => s.md5 === 'm1').name, '无语');
  assert.equal(merged.find((s) => s.md5 === 'm2').name, '');
  assert.deepEqual(needNames(merged).map((s) => s.md5), ['m2'], '只给没名字的花视觉调用');
});

test('挑图：精确 → 包含；挑不到就是 null', () => {
  const items = [{ md5: 'a', url: 'u1', name: '无语' }, { md5: 'b', url: 'u2', name: '委屈' }];
  assert.equal(pickSticker(items, '无语').url, 'u1');
  assert.equal(pickSticker(items, '有点委屈').name, '委屈');
  assert.equal(pickSticker(items, '笑死'), null, '挑不到不发，比拿一张不相干的顶替更糟');
  assert.equal(pickSticker(items, ''), null);
  assert.equal(pickSticker([], '无语'), null);
});

test('名字可能很长：起名之后要截断', () => {
  const got = parseFavorites([{ md5: 'm', url: 'u', desc: '这个表情表达了一种极度无语的心情' }]);
  assert.equal(got[0].name.length, MAX_NAME);
});

test('注入那一行：只有名字，没有 url', () => {
  const line = namesLine([{ md5: 'a', url: 'https://p.qpic.cn/secret/a', name: '无语' }, { name: '委屈' }]);
  assert.match(line, /无语/);
  assert.match(line, /委屈/);
  assert.doesNotMatch(line, /qpic\.cn/, '路径和地址不该进上下文');
  assert.match(line, /\[表情:名字\]/, '得告诉她怎么写');
  assert.equal(namesLine([]), '');
});
