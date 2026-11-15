// 感知记忆的索引：去重、条数上限、容量清理、冷清理。纯函数，不碰磁盘。
import test from 'node:test';
import assert from 'node:assert/strict';
import { addRecord, createIndex, pruneCold, prunePixels, sha12, statsOf } from '../src/perception/store.js';

const DAY = 86400e3;
const rec = (over = {}) => ({
  id: 'p_1', sha: 'a', at: 0, file: 'f1.jpg', thumb: 'f1.thumb.jpg', pixels: true,
  bytes: 100, title: 't', desc: 'd', slots: {}, hits: 0, lastHitAt: 0, heat: 0.1, ...over,
});

test('sha12 是 sha256 前 12 位，同样的字节一样', () => {
  const b = Buffer.from('hello');
  assert.equal(sha12(b).length, 12);
  assert.equal(sha12(b), sha12(Buffer.from('hello')));
});

test('同 sha 第二次：不新增，只加 hits 和 lastHitAt', () => {
  let idx = addRecord(createIndex(), rec());
  idx = addRecord(idx, rec({ at: 5000 }));
  assert.equal(idx.records.length, 1);
  assert.equal(idx.records[0].hits, 1);
  assert.equal(idx.records[0].lastHitAt, 5000);
  assert.equal(idx.stats.deduped, 1);
});

test('超过条数上限：淘汰最久没被找回过的那条', () => {
  let idx = createIndex();
  idx = addRecord(idx, rec({ id: 'p_1', sha: 'a', lastHitAt: 9000 }));
  idx = addRecord(idx, rec({ id: 'p_2', sha: 'b', lastHitAt: 0, at: 1 }), { maxRecords: 2 });
  idx = addRecord(idx, rec({ id: 'p_3', sha: 'c', lastHitAt: 8000 }), { maxRecords: 2 });
  assert.equal(idx.records.length, 2);
  assert.equal(idx.records.some((r) => r.id === 'p_2'), false, '被找回过的不该先淘汰');
});

test('容量超限：删最老的原图，记录留着、pixels 变 false', () => {
  let idx = createIndex();
  idx = addRecord(idx, rec({ id: 'p_old', sha: 'a', bytes: 100, at: 1 }));
  idx = addRecord(idx, rec({ id: 'p_new', sha: 'b', bytes: 100, at: 2, file: 'f2.jpg' }));
  const out = prunePixels(idx, { maxBytes: 150 });
  assert.deepEqual(out.removed, ['f1.jpg']);
  assert.equal(out.index.records.length, 2, '记录不删');
  assert.equal(out.index.records[0].pixels, false);
  assert.equal(out.index.records[1].pixels, true);
});

test('冷清理：只删「没被找回 + 够老 + 当时不重」的', () => {
  const now = 200 * DAY;
  let idx = createIndex();
  idx = addRecord(idx, rec({ id: 'p_cold', sha: 'a', at: 0, heat: 0.1, file: 'cold.jpg', thumb: 'cold.thumb.jpg' }));
  idx = addRecord(idx, rec({ id: 'p_hot', sha: 'b', at: 0, heat: 0.8, file: 'hot.jpg' }));
  idx = addRecord(idx, rec({ id: 'p_hit', sha: 'c', at: 0, heat: 0.1, hits: 2, file: 'hit.jpg' }));
  idx = addRecord(idx, rec({ id: 'p_fresh', sha: 'd', at: now - DAY, heat: 0.1, file: 'fresh.jpg' }));
  const out = pruneCold(idx, { now });
  assert.deepEqual(out.removed, ['cold.jpg', 'cold.thumb.jpg'], '整条删：原图和缩略图都要删');
  assert.equal(out.index.records.length, 3);
});

test('statsOf 数得对', () => {
  let idx = addRecord(createIndex(), rec({ id: 'p_1', sha: 'a', bytes: 100 }));
  idx = addRecord(idx, rec({ id: 'p_2', sha: 'b', bytes: 100, pixels: false }));
  assert.deepEqual(statsOf(idx), { total: 2, pixels: 1, bytes: 100 }, '只算还在盘上的原图');
});

test('冷清理不碰「没有文件可回收」的记录：迁移来的只靠 desc 活着', () => {
  let idx = createIndex();
  idx = addRecord(idx, rec({ id: 'p_mig', sha: 'a', at: 0, heat: null, file: '', thumb: '', pixels: false }));
  idx = addRecord(idx, rec({ id: 'p_cold', sha: 'b', at: 0, heat: 0.1, file: 'cold.jpg', thumb: 'cold.thumb.jpg' }));
  const out = pruneCold(idx, { now: 200 * DAY });
  assert.deepEqual(out.index.records.map((r) => r.id), ['p_mig'], '它已经没有文件可删，删它就是删掉唯一的那份描述');
  assert.deepEqual(out.removed, ['cold.jpg', 'cold.thumb.jpg']);
});

test('原图被清理后又重发同一张：索引要把 pixels 改回 true', () => {
  let idx = createIndex();
  idx = addRecord(idx, rec({ id: 'p_1', sha: 'a', bytes: 100 }));
  idx = prunePixels(idx, { maxBytes: 0 }).index;              // 原图被删掉，记录还在
  assert.equal(idx.records[0].pixels, false);
  idx = addRecord(idx, rec({ id: 'p_1', sha: 'a', bytes: 120 })); // 他又发了一次（文件已重写）
  assert.equal(idx.records[0].pixels, true, '盘上有文件，索引不能再说没有');
  assert.equal(idx.records[0].bytes, 120);
});

test('去重时不改入参里的那条记录', () => {
  const first = createIndex();
  const idx = addRecord(first, rec({ id: 'p_1', sha: 'a' }));
  const second = addRecord(idx, rec({ id: 'p_1', sha: 'a', at: 5000 }));
  assert.equal(second.records[0].hits, 1);
  assert.equal(idx.records[0].hits, 0, '旧索引不能被改：它可能还被调用方拿着');
  assert.equal(first.stats.deduped, 0, '入参的 stats 也不能被改');
});

test('占用只算还在盘上的原图', () => {
  let idx = addRecord(createIndex(), rec({ id: 'p_1', sha: 'a', bytes: 100 }));
  idx = addRecord(idx, rec({ id: 'p_2', sha: 'b', bytes: 100, pixels: false }));
  assert.equal(statsOf(idx).bytes, 100, '删掉的原图不能再算进「占 X MB」');
});
