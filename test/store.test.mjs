// 落盘：正常存取、坏文件不至于让插件起不来、备份节流。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../src/store.js';
import { initState, applyDamage } from '../src/affect/core.js';

const dir = () => mkdtempSync(join(tmpdir(), 'qqc-'));

test('存了再读，内容一致', () => {
  const file = join(dir(), 'affect.json');
  const s = createJsonStore(file, { defaults: () => initState(0) });
  const st = applyDamage(initState(0), 0.05, 0).state;
  s.save(st);
  assert.deepEqual(s.load(), st);
});

test('没有文件时返回初始状态', () => {
  const s = createJsonStore(join(dir(), 'nope.json'), { defaults: () => initState(0) });
  assert.equal(s.load().version, 1);
});

test('坏文件：留证并回初始状态，不抛错', () => {
  const d = dir();
  const file = join(d, 'affect.json');
  writeFileSync(file, '{ not json');
  const logged = [];
  const s = createJsonStore(file, { defaults: () => initState(0), log: (m) => logged.push(m) });
  assert.equal(s.load().version, 1);
  assert.equal(logged.length, 1);
  assert.ok(readdirSync(d).some((n) => n.startsWith('affect.json.corrupt-')), '坏文件应改名留证');
});

test('变化即备份：过了节流窗口才留上一版', () => {
  const d = dir();
  const file = join(d, 'affect.json');
  let clock = 0;
  const s = createJsonStore(file, { defaults: () => ({}), now: () => clock, backupEveryMs: 1000 });
  s.save({ a: 1 });            // 还没有文件，没得备
  clock = 500;
  s.save({ a: 2 });            // 距上次备份足够久 → 备下 {a:1}
  assert.deepEqual(JSON.parse(readFileSync(join(d, 'affect.json.bak'), 'utf8')), { a: 1 });
  clock = 600;
  s.save({ a: 3 });            // 窗口内 → 不覆盖备份
  assert.deepEqual(JSON.parse(readFileSync(join(d, 'affect.json.bak'), 'utf8')), { a: 1 });
});

test('没有 .tmp 残留', () => {
  const d = dir();
  const s = createJsonStore(join(d, 'x.json'), { defaults: () => ({}) });
  s.save({ a: 1 });
  assert.deepEqual(readdirSync(d), ['x.json']);
});
