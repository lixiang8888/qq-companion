// 未答的问题：拆句、挑提问、留一条给下一轮。纯函数。
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractQuestions, leftoverQuestions, looksLikeQuestion, pendingLine } from '../src/topics.js';

test('带问号的算提问', () => {
  assert.equal(looksLikeQuestion('睡了吗？'), true);
  assert.equal(looksLikeQuestion('你吃了吗'), true, '「吗」结尾也算');
  assert.equal(looksLikeQuestion('这是什么'), true);
  assert.equal(looksLikeQuestion('我先睡了'), false);
});

test('一段话里挑出多个问题，保持顺序', () => {
  const qs = extractQuestions('你会做饭吗？今天几点睡的？我有点累');
  assert.deepEqual(qs, ['你会做饭吗', '今天几点睡的']);
});

test('只有一条时不留旧账', () => {
  assert.deepEqual(leftoverQuestions(['你吃了吗']), []);
  assert.deepEqual(leftoverQuestions([]), []);
});

test('两条以上时，最后一条是她在答的，剩下的挂起来', () => {
  assert.deepEqual(leftoverQuestions(['你吃了吗', '今天几点睡的']), ['你吃了吗']);
});

test('最多挂两条：挂太多会变成追旧账', () => {
  const many = ['a问', 'b问', 'c问', 'd问'];
  assert.equal(leftoverQuestions(many).length, 2);
});

test('注入那一行：没东西就不占提示词', () => {
  assert.equal(pendingLine([]), '');
  const line = pendingLine(['你吃了吗']);
  assert.match(line, /你吃了吗/);
  assert.match(line, /别装没看见/);
});
