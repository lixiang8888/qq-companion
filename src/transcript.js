// 聊天原文归档：只追加，按月一个文件。
//
// 为什么要有：会话压缩之后原文就没了，她只剩摘要和记忆碎片。真机上她说过
// 「你说过『等我练出八块腹肌』，但为什么我不记得」——那条原话就在隔壁，只是没地方查。
//
// 边界：这里只负责「存」和「按关键词找回来」。找回来的是**原话**，带着时间戳，
// 由她把原话接进自己的话里；不做摘要、不做推断。

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stampOf } from './session.js';

/** 什么算「他在回忆」：只有这种话才值得去翻旧账，否则每句都翻会把她变成检索机。 */
export const RECALL_MARKERS = /记得|记不记得|还记|忘了|上次|上回|之前|那天|那次|那时候|说过|提过|以前|前几|昨天你说|早上说/;

export const MAX_RECALL = 3;
export const MAX_LINE_CHARS = 80;
export const MONTHS_BACK = 3;

export const looksLikeRecall = (text) => RECALL_MARKERS.test(String(text || ''));

export function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 中文没有空格，按 2-gram 切；英文/数字按词。 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const run of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
    if (run.length === 1) out.add(run);
  }
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  return [...out];
}

/** 追加一条。写不进去就算了——归档失败不该挡着她回话。 */
export function appendTranscript(dir, { at, role, text }) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return false;
  try {
    const file = join(dir, `transcript-${monthKey(at)}.jsonl`);
    appendFileSync(file, `${JSON.stringify({ at: Number(at), role: role === 'assistant' ? 'assistant' : 'user', text: body })}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 读最近几个月。坏行跳过——不能因为一行坏了就整份读不出来。 */
export function readTranscript(dir, { now = Date.now(), months = MONTHS_BACK } = {}) {
  const rows = [];
  const base = new Date(now);
  for (let i = 0; i < months; i += 1) {
    const key = monthKey(new Date(base.getFullYear(), base.getMonth() - i, 1).getTime());
    const file = join(dir, `transcript-${key}.jsonl`);
    if (!existsSync(file)) continue;
    let raw = '';
    try { raw = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r?.at && r?.text) rows.push({ at: Number(r.at), role: r.role === 'assistant' ? 'assistant' : 'user', text: String(r.text) });
      } catch { /* 坏行跳过 */ }
    }
  }
  return rows;
}

/**
 * 按 2-gram 重合度找原话。命中数除以长度平方根——防止一条长记录靠重复词刷分。
 * `exclude` 传当前这句话，免得把她「这一轮刚听过的」当成「翻到的旧话」。
 */
export function searchTranscript(rows = [], query = '', { limit = MAX_RECALL, exclude = '' } = {}) {
  const qset = new Set(tokenize(query));
  if (!qset.size) return [];
  const scored = [];
  for (const r of rows) {
    if (r.text.length < 4) continue;
    if (exclude && r.text === exclude) continue;
    const toks = tokenize(r.text);
    let hit = 0;
    for (const t of toks) if (qset.has(t)) hit += 1;
    if (!hit) continue;
    scored.push({ ...r, score: hit / Math.sqrt(toks.length || 1) });
  }
  scored.sort((a, b) => b.score - a.score || b.at - a.at);
  return scored.slice(0, limit);
}

const clip = (text) => {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS)}…` : s;
};

/** 拼成她上下文里的一段。必须写明「不是他这一轮说的」，否则她会当成刚发生的事。 */
export function recallLine(hits = [], { now = Date.now() } = {}) {
  if (!hits.length) return '';
  const lines = hits.map((h) => `- ${stampOf(h.at, now)} ${h.role === 'user' ? '他' : '你'}：${clip(h.text)}`);
  return `【翻到的原话】（聊天记录里的原话，不是他这一轮说的；前后文没有是正常的）\n${lines.join('\n')}`;
}
