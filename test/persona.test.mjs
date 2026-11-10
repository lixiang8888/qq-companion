// 人格卡分层、这一轮是什么场合、以及「她绕回来了」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STUCK_LINE, looksStuck, situationText, situationsFor, splitPersona, systemPersona,
} from '../src/persona.js';

const OLD = `# 角色卡
## 一、你是谁
你是一条小鲸鱼。
## 二、怎么说话
- 一句 1~10 字。
`;

const LAYERED = `# 角色卡

## 内核
我是小鲸鱼。底线：越权不做。

## 风格默认
- 默认一句 1~10 字。

## 情境

### 他明确要一段长的
可以连发几条。

### 他低落或很认真
放下傲娇。

### 他要你换个语气
换语气，不换身份。

### 他在深夜还不睡
劝过一次就够。
`;

test('老人格卡（没标记）：整份当内核，注入的文字一个字不变', () => {
  const p = splitPersona(OLD);
  assert.equal(p.marked, false);
  assert.equal(p.core, OLD.trim());
  assert.equal(p.style, '');
  assert.deepEqual(p.situations, []);
  assert.equal(systemPersona(OLD), OLD.trim(), '没有标记就必须原样注入——这是回滚保险');
});

test('分层人格卡：内核和风格默认分开，情境认出四个场合', () => {
  const p = splitPersona(LAYERED);
  assert.equal(p.marked, true);
  assert.match(p.core, /小鲸鱼/);
  assert.doesNotMatch(p.core, /1~10 字/, '风格不该混进内核');
  assert.match(p.style, /1~10 字/);
  assert.doesNotMatch(p.style, /连发几条/, '情境不该混进风格');
  assert.deepEqual(p.situations.map((s) => s.key), ['long', 'soothe', 'play', 'night']);

  const sys = systemPersona(LAYERED);
  assert.match(sys, /小鲸鱼/);
  assert.match(sys, /1~10 字/);
  assert.doesNotMatch(sys, /劝过一次就够/, '情境按轮拼，不进 system');
});

test('这一轮是什么场合：正例与反例', () => {
  const at = (h) => new Date(2026, 0, 1, h, 0, 0).getTime();
  const noon = at(14);
  assert.ok(situationsFor('给我讲讲你小时候', { at: noon }).includes('long'));
  assert.ok(!situationsFor('别跟我讲道理', { at: noon }).includes('long'), '「讲道理」不是要长内容');
  assert.ok(situationsFor('哄哄我', { at: noon }).includes('soothe'));
  assert.ok(!situationsFor('他哭了', { at: noon }).includes('soothe'), '没提哄/安慰就不算');
  assert.ok(situationsFor('装妈妈哄我睡', { at: noon }).includes('play'));
  assert.ok(!situationsFor('你语气真欠', { at: noon }).includes('play'), '「语气」单说不算要他换语气');
  assert.ok(situationsFor('在吗', { at: at(2) }).includes('night'));
  assert.ok(!situationsFor('在吗', { at: noon }).includes('night'), '中午不是深夜');
});

test('情境拼装：只拼命中的那几段，没命中就是空串', () => {
  assert.equal(situationText(LAYERED, []), '');
  const long = situationText(LAYERED, ['long']);
  assert.match(long, /连发几条/);
  assert.doesNotMatch(long, /劝过一次/);
  const both = situationText(LAYERED, ['play', 'night']);
  assert.match(both, /换语气/);
  assert.match(both, /劝过一次/);
  assert.equal(situationText(OLD, ['long']), '', '老人格卡没有情境段，拼不出来也不能硬编');
});

test('打转检测：三条同义句命中，三条不同话题不命中', () => {
  assert.equal(looksStuck(['去睡吧', '快去睡吧', '去睡啦']), true);
  assert.equal(looksStuck(['我在吃饭', '今天好累', '那个电影挺好看']), false);
  assert.equal(looksStuck(['去睡吧', '快去睡吧']), false, '只有两条看不出来');
  assert.equal(looksStuck(['去睡吧', '快去睡吧', '今天好累']), false, '有一条跑开了就不算绕圈');
  assert.ok(STUCK_LINE.includes('绕回来'));
});

test('打转检测：超短回复不参与，否则她永远在「绕圈」', () => {
  assert.equal(looksStuck(['好', '嗯', '？', '行吧']), false);
  assert.equal(looksStuck(['好', '嗯', '？', '在吗你在吗']), false);
});
