// 日记：素材只能是真实差分——她今天记住了什么、忘了什么、哪些事比昨天模糊了。
// 全本地时间，跨午夜按本地日界算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineOf, composePrompt, dayKey, diff, dueDay, previousDay, readDiaries, snapshot, startOfDay, writeDiary } from '../src/diary.js';
import { createCard, forget, remember } from '../src/memory/card.js';

const DAY = 86400e3;
const at = (d, h = 0, m = 0) => new Date(2026, 9, d, h, m, 0).getTime();
const T0 = at(28, 20, 0);

test('日记的日期按本地日界算：凌晨 00:30 还是当天，不是 UTC 的昨天', () => {
  assert.equal(dayKey(at(28, 0, 30)), '2026-10-28');
  assert.equal(dayKey(at(28, 23, 59)), '2026-10-28');
  assert.equal(dayKey(at(1, 0, 0)), '2026-10-01');
  assert.equal(startOfDay(at(28, 15, 30)), at(28, 0, 0));
});

test('哪天该写：23 点前写昨天，23 点后写今天（跨午夜不会写错一天）', () => {
  assert.equal(dueDay(at(28, 22, 0)), '2026-10-27');
  assert.equal(dueDay(at(28, 23, 30)), '2026-10-28');
  assert.equal(dueDay(at(29, 0, 30)), '2026-10-28');
  assert.equal(dueDay(at(29, 9, 0)), '2026-10-28');
});

test('快照只数今天：今天记住几条、忘了几条、现在还剩几条', () => {
  let card = createCard(T0);
  card = remember(card, '他明天要考试', { now: at(28, 9) });
  card = remember(card, '他养了只猫叫团子', { now: at(27, 9) });
  card = forget(card, card.records[1].id, at(28, 15));

  const snap = snapshot({ card, now: T0 });
  assert.equal(snap.remembered, 1);
  assert.equal(snap.forgotten, 1);
  assert.equal(snap.size, 1, '软删除的不算「还记着的」');
  assert.equal(snap.marks[card.records[0].id], 3, '清晰度用档位数字存，便于比大小');
});

test('差分：只数「比昨天模糊了」的，新记的不算', () => {
  const prev = { marks: { a: 3, b: 3, c: 2 }, forgotten: 0, compactions: 0 };
  const cur = { marks: { a: 3, b: 2, c: 0, d: 3 }, forgotten: 1, compactions: 2, remembered: 1, size: 3 };
  const d = diff(prev, cur, { now: T0, lastUserAt: T0 - 5 * 3600e3 });
  assert.equal(d.faded, 2, 'b 掉一档、c 掉两档；新记的 d 不算');
  assert.equal(d.forgotten, 1);
  assert.equal(d.compactions, 2);
  assert.equal(d.idleHours, 5);
});

test('第一次跑没有昨天：数字照样是真的，不许算成零', () => {
  const cur = { marks: { a: 3 }, forgotten: 2, compactions: 4, remembered: 2, size: 1 };
  const d = diff(null, cur, { now: T0, lastUserAt: 0 });
  assert.equal(d.remembered, 2);
  assert.equal(d.forgotten, 2, '没有基线时也要用绝对数，不能谎报成 0');
  assert.equal(d.faded, 0);
  assert.equal(d.compactions, 0);
  assert.equal(d.idleHours, 0);
});

test('提示词里只有真实的事：没有「今天很开心」这种编的', () => {
  const d = { remembered: 1, forgotten: 1, faded: 2, compactions: 1, idleHours: 5, rememberedTexts: ['他明天要考试'], fadedTexts: [] };
  const p = composePrompt('2026-10-28', d);
  assert.match(p, /2026-10-28/);
  assert.match(p, /他明天要考试/);
  assert.match(p, /1 件/, '记住的一条要出现在提示词里');
  assert.match(p, /2 条.*模糊|模糊.*2 条/);
  assert.match(p, /5 小时/);
  assert.doesNotMatch(p, /开心|难过|幸福|充实/, '心情由她自己写，插件不给形容词');
});

test('什么都没发生：不写空话', () => {
  assert.equal(composePrompt('2026-10-28', { remembered: 0, forgotten: 0, faded: 0, compactions: 0, idleHours: 0 }), '');
});

test('落盘：一天一个文件，目录自动建，写坏了看得见', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-diary-'));
  const path = writeDiary(dir, '2026-10-28', '  今天他一直在忙。\n');
  assert.equal(path, join(dir, 'diary', '2026-10-28.md'));
  assert.equal(readFileSync(path, 'utf8'), '今天他一直在忙。');
});

test('读最近几天：给面板用，没有就是空数组', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-diary-'));
  assert.deepEqual(readDiaries(dir, { limit: 3 }), []);
  for (const d of ['2026-10-26', '2026-10-27', '2026-10-28']) writeDiary(dir, d, `${d} 的事`);
  const got = readDiaries(dir, { limit: 3 });
  assert.deepEqual(got.map((x) => x.date), ['2026-10-28', '2026-10-27', '2026-10-26']);
  assert.equal(got[0].text, '2026-10-28 的事');
  assert.ok(existsSync(join(dir, 'diary', '2026-10-28.md')));
});

test('基线只认前一天：隔了三天还说「比昨天模糊」就是编的', () => {
  assert.equal(previousDay('2026-10-28'), '2026-10-27');
  assert.equal(previousDay('2026-11-01'), '2026-10-31');
  assert.equal(previousDay('2026-03-01'), '2026-02-28');
  assert.deepEqual(baselineOf({ date: '2026-10-27', snap: { marks: {} } }, '2026-10-28').marks, {});
  assert.equal(baselineOf({ date: '2026-10-24', snap: { marks: {} } }, '2026-10-28'), null);
  assert.equal(baselineOf({}, '2026-10-28'), null);
});

test('日记文件名不接受路径穿越：日期只当日期用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-diary-'));
  assert.throws(() => writeDiary(dir, '../../evil', 'x'), /日期/);
  assert.equal(existsSync(join(dir, 'diary')), false, '不该已经建出目录来');
});

void DAY;
