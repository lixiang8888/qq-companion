// 聊天原文归档：只追加、按月一个文件；以及「他问起旧事时怎么翻回来」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MONTHS_BACK, appendTranscript, looksLikeRecall, monthKey, readTranscript, recallLine, searchTranscript, tokenize,
} from '../src/transcript.js';

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m, 0).getTime();
const NOW = at(9, 21, 0);

test('按月切文件：一个月的记录落在同一个 jsonl 里', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-tr-'));
  assert.equal(monthKey(at(9, 10)), '2026-11');
  assert.equal(appendTranscript(dir, { at: at(9, 10), role: 'user', text: '等我练出8块腹肌' }), true);
  assert.equal(appendTranscript(dir, { at: at(9, 11), role: 'assistant', text: '你又说这个' }), true);
  assert.deepEqual(readdirSync(dir), ['transcript-2026-11.jsonl']);
  const rows = readTranscript(dir, { now: NOW });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[1].role, 'assistant');
});

test('空话不记：空白和只有空格的不该占一行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-tr-'));
  assert.equal(appendTranscript(dir, { at: NOW, role: 'user', text: '   ' }), false);
  assert.equal(readTranscript(dir, { now: NOW }).length, 0);
});

test('坏行跳过，不能因为一行坏了整份读不出来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-tr-'));
  appendTranscript(dir, { at: at(9, 10), role: 'user', text: '正常一句' });
  writeFileSync(join(dir, 'transcript-2026-11.jsonl'), `不是 json\n{"text":"没有时刻"}\n{"at":${at(9, 11)},"role":"user","text":"又一句正常"}\n`, { flag: 'a' });
  const rows = readTranscript(dir, { now: NOW });
  assert.ok(rows.some((r) => r.text === '正常一句'));
  assert.ok(rows.some((r) => r.text === '又一句正常'));
  assert.equal(rows.length, 2, '两行坏的都不该进来');
});

test('中文按 2-gram 切，英文按词', () => {
  const t = tokenize('练腹肌 API');
  assert.ok(t.includes('练腹') && t.includes('腹肌'));
  assert.ok(t.includes('api'));
});

test('只读最近几个月，老文件不碰', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-tr-'));
  appendTranscript(dir, { at: new Date(2026, 5, 1, 10).getTime(), role: 'user', text: '六月的一句话' });
  appendTranscript(dir, { at: at(9, 10), role: 'user', text: '十一月的一句话' });
  const rows = readTranscript(dir, { now: NOW });
  assert.ok(rows.some((r) => r.text === '十一月的一句话'));
  assert.ok(!rows.some((r) => r.text === '六月的一句话'), `${MONTHS_BACK} 个月之前的就不读了`);
});

test('什么话才算「他在回忆」', () => {
  for (const s of ['我为什么要去健身你还记得吗', '上次那个电影叫什么', '你之前说过的', '那天你怎么回的', '你昨天你说啥了']) {
    assert.equal(looksLikeRecall(s), true, s);
  }
  for (const s of ['在吗', '今天好累', '嗯', '吃饭了没']) {
    assert.equal(looksLikeRecall(s), false, s);
  }
});

test('翻旧账：命中的是原话，且排掉他这一轮刚说的那句', () => {
  const rows = [
    { at: at(6, 21, 44), role: 'user', text: '知道我为什么要健身吗' },
    { at: at(6, 21, 46), role: 'assistant', text: '你说过要练腹肌' },
    { at: at(8, 10, 0), role: 'user', text: '今天好累啊' },
  ];
  const q = '我为什么会去健身，你还记得吗';
  const hits = searchTranscript(rows, q, { exclude: q });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].text, '知道我为什么要健身吗');
  assert.ok(!hits.some((h) => h.text === q), '他这一句不能当成翻到的旧话');
  assert.ok(!hits.some((h) => h.text === '今天好累啊'), '不相关的不要');
});

test('先说清楚它的边界：2-gram 只看字面，「健身」搜不到「腹肌」', () => {
  // 这不是 bug，是选型代价。要跨用词找意思得靠向量检索，而那要另一套成本。
  // 所以记忆卡仍然必要：它按重要性长期保留「等我练出8块腹肌」这类碎片。
  const rows = [{ at: at(6, 21, 46), role: 'user', text: '等我练出8块腹肌' }];
  assert.deepEqual(searchTranscript(rows, '我为什么要健身你还记得吗'), []);
  assert.equal(searchTranscript(rows, '我说过腹肌的事你还记得吗').length, 1, '同一个词就能搜到');
});

test('翻旧账：空的查询返回空，不炸', () => {
  assert.deepEqual(searchTranscript([], '', {}), []);
  assert.deepEqual(searchTranscript([{ at: NOW, role: 'user', text: '健身' }], '   '), []);
});

test('拼进上下文的那段：带日期、标明不是这一轮说的', () => {
  const line = recallLine([
    { at: at(6, 21, 44), role: 'user', text: '知道我为什么要健身吗' },
    { at: at(6, 21, 46), role: 'user', text: '等我练出8块腹肌' },
  ], { now: NOW });
  assert.match(line, /翻到的原话/);
  assert.match(line, /不是他这一轮说的/);
  assert.match(line, /他：知道我为什么要健身吗/);
  assert.match(line, /他：等我练出8块腹肌/);
  assert.match(line, /21:46/);
  assert.equal(recallLine([], { now: NOW }), '');
});

test('原话太长要截断：不能一句话吃掉整个上下文预算', () => {
  const long = '练'.repeat(300);
  const line = recallLine([{ at: NOW, role: 'user', text: long }], { now: NOW });
  assert.ok(line.includes('…'));
  assert.ok(line.length < 200);
});
