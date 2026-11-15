// 感知记忆的索引：纯函数，不碰磁盘。
//
// 为什么不落 jsonl 只追加：同 sha 第二次要改 hits、清理要改 pixels，追加式文件做这些要多读一遍整月。
// 记录量级是「几千张图、几百 KB」，整份读改写最省事——和记忆卡一个路子。
//
// 删除文件由调用方做（这里只返回路径），因为纯函数不该有副作用。

import { createHash } from 'node:crypto';

export const DAY_MS = 86400e3;
export const MAX_RECORDS = 4000;
export const MAX_PIXELS_BYTES = 2 * 1024 ** 3;   // 2G
export const COLD_DAYS = 90;
export const COLD_HEAT = 0.35;

/** 内容哈希的前 12 位：同一张图重复发，盘上只留一份。 */
export function sha12(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

export function createIndex() {
  return { version: 1, records: [], stats: { added: 0, deduped: 0, pruned: 0, cold: 0 } };
}

const ageOf = (r) => Number(r.lastHitAt) || Number(r.at) || 0;

/**
 * 记一条。同 sha 已存在 → 只算「又见了一次」，不新增记录。
 * 超上限 → 淘汰最久没被找回过的那条（没被找回过的按加入时间算）。
 */
export function addRecord(index, rec, { maxRecords = MAX_RECORDS } = {}) {
  const next = { ...index, records: [...(index?.records || [])], stats: { ...(index?.stats || {}) } };
  const same = next.records.findIndex((r) => r.sha && r.sha === rec.sha);
  if (same >= 0) {
    const old = next.records[same];
    // 换一条新对象，别原地改——入参可能是调用方还在用的索引。
    next.records[same] = {
      ...old,
      hits: (Number(old.hits) || 0) + 1,
      lastHitAt: Number(rec.at) || old.lastHitAt || 0,
      // 他没删图、又发了一遍：文件刚被重写过，索引得承认它在。
      pixels: rec.pixels === undefined ? old.pixels : Boolean(rec.pixels),
      bytes: Number(rec.bytes) || old.bytes,
    };
    next.stats.deduped = (next.stats.deduped || 0) + 1;
    return next;
  }
  next.records.push(rec);
  next.stats.added = (next.stats.added || 0) + 1;
  if (next.records.length > maxRecords) {
    const over = next.records.length - maxRecords;
    const victims = [...next.records].sort((a, b) => ageOf(a) - ageOf(b)).slice(0, over);
    const drop = new Set(victims.map((v) => v.id));
    next.records = next.records.filter((r) => !drop.has(r.id));
    next.stats.pruned = (next.stats.pruned || 0) + victims.length;
  }
  return next;
}

/** 总量超了：从最老的开始删原图，记录和缩略图都留着（「记得是什么」比「能再看清」便宜）。 */
export function prunePixels(index, { maxBytes = MAX_PIXELS_BYTES } = {}) {
  const next = { ...index, records: (index?.records || []).map((r) => ({ ...r })), stats: { ...(index?.stats || {}) } };
  const removed = [];
  const total = () => next.records.reduce((s, r) => s + (r.pixels ? Number(r.bytes) || 0 : 0), 0);
  const oldest = () => [...next.records].filter((r) => r.pixels).sort((a, b) => ageOf(a) - ageOf(b))[0];
  while (total() > maxBytes) {
    const victim = oldest();
    if (!victim) break;
    victim.pixels = false;
    if (victim.file) removed.push(victim.file);
  }
  if (removed.length) next.stats.pruned = (next.stats.pruned || 0) + removed.length;
  return { index: next, removed };
}

/** 冷清理：没被找回 + 够老 + 当时不重 → 整条删掉（连缩略图）。热的那次永远不由这条管。 */
export function pruneCold(index, { now = 0, days = COLD_DAYS, heat = COLD_HEAT } = {}) {
  const cut = Number(now) - days * DAY_MS;
  const removed = [];
  const kept = [];
  for (const r of index?.records || []) {
    // 没有文件可回收的记录不归这条管：删掉它就等于删掉唯一的那份描述（迁移来的记录就是这样）。
    const cold = Boolean(r.file || r.thumb)
      && !(Number(r.hits) > 0)
      && (Number(r.at) || 0) < cut
      && !(Number(r.heat) >= heat);
    if (!cold) { kept.push(r); continue; }
    if (r.file) removed.push(r.file);
    if (r.thumb) removed.push(r.thumb);
  }
  const next = { ...index, records: kept, stats: { ...(index?.stats || {}) } };
  if (removed.length) next.stats.cold = (next.stats.cold || 0) + removed.length;
  return { index: next, removed };
}

export function statsOf(index) {
  const records = index?.records || [];
  return {
    total: records.length,
    pixels: records.filter((r) => r.pixels).length,
    bytes: records.reduce((s, r) => s + (r.pixels ? Number(r.bytes) || 0 : 0), 0),
  };
}
