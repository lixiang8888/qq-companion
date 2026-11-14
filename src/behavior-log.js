// 她的行为账本：每轮一行，只记「我怎么说的」。
//
// 为什么需要它：人格卡上写着「不要每条都关心人」，但她看不见自己犯没犯。
// looksStuck 只在当下那一轮点一下，不沉淀；周自述又只拿记忆卡当素材，所以她永远不知道
// 「这周我有 12 次在说同一个意思」。
//
// 一条硬规矩：**不记他说了什么**。账本是给她照镜子的，不是监控他。
// 所以行里只有条数、字数、情境、是否打转、开头几个字——都是她自己的行为。

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const WEEK_MS = 7 * 86400e3;
// 整句 ≤12 字且出现这些词，才算「疑似拒绝」。是疑似，不是事实——别的话也可能只回一句「不用」。
export const REFUSE_WORDS = /不行|不要|不想|不用|算了|不必/;
export const REFUSE_MAX_CHARS = 12;
export const OPEN_CHARS = 6;

const pad2 = (n) => String(n).padStart(2, '0');
export const monthKeyOf = (t) => {
  const d = new Date(Number(t) || 0);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};
export const fileOf = (dataDir, at) => join(dataDir, `behavior-${monthKeyOf(at)}.jsonl`);

/** 这句像不像一次拒绝（只认短句，长句里的「不」不算）。 */
export function looksLikeRefusal(said) {
  const s = String(said || '').replace(/\s+/g, '');
  if (!s || s.length > REFUSE_MAX_CHARS) return false;
  return REFUSE_WORDS.test(s);
}

/**
 * 一轮的账。
 * @param {{at:number, parts:number, chars:number, situations?:string[], said?:string, stuck?:boolean}} o
 */
export function entryOf({ at, parts = 0, chars = 0, situations = [], said = '', stuck = false } = {}) {
  return {
    at: Number(at) || 0,
    parts: Number(parts) || 0,
    chars: Number(chars) || 0,
    situations: [...new Set((situations || []).filter(Boolean))].slice(0, 4),
    stuck: Boolean(stuck),
    refused: looksLikeRefusal(said),
    // 她自己那句话的开头几个字。够用来数「最常说的一句」，又不用把整段话存下来。
    open: String(said || '').replace(/\s+/g, '').slice(0, OPEN_CHARS),
  };
}

/** 只追加：账本永远不该被改写。 */
export function appendBehavior(dataDir, entry) {
  appendFileSync(fileOf(dataDir, entry.at), `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/** 读一段时间内的账。跨月就把两个文件都读上。 */
export function readBehavior(dataDir, { from = 0, to = Date.now() } = {}) {
  const months = new Set([monthKeyOf(from), monthKeyOf(to)]);
  const out = [];
  for (const m of months) {
    const p = join(dataDir, `behavior-${m}.jsonl`);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (Number(e?.at) >= from && Number(e?.at) <= to) out.push(e);
      } catch { /* 坏行就当没写过，别让一行脏数据毁掉整周 */ }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 一周的统计。全是数字，不带评价——评价留给她自己写。 */
export function weekStats(entries = []) {
  const turns = entries.length;
  if (!turns) return null;
  const nums = (k) => entries.map((e) => Number(e[k]) || 0);
  const parts = nums('parts');
  const chars = nums('chars');
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const situations = {};
  for (const e of entries) {
    for (const s of e.situations || []) situations[s] = (situations[s] || 0) + 1;
  }
  const opens = {};
  for (const e of entries) {
    if (e.open) opens[e.open] = (opens[e.open] || 0) + 1;
  }
  const top = Object.entries(opens).sort((a, b) => b[1] - a[1])[0] || null;
  return {
    turns,
    avgParts: Math.round((sum(parts) / turns) * 10) / 10,
    maxParts: Math.max(...parts),
    avgChars: Math.round(sum(chars) / turns),
    short: chars.filter((c) => c > 0 && c <= 6).length,
    stuck: entries.filter((e) => e.stuck).length,
    refused: entries.filter((e) => e.refused).length,
    situations,
    // 少于 3 次不算「最常说」——那是巧合，说出来就成了假的规律。
    topOpen: top && top[1] >= 3 ? { text: top[0], n: top[1] } : null,
  };
}

/** 喂给周自述的那段材料。陈述句、带数字、不解释。 */
export function statsText(s) {
  if (!s?.turns) return '';
  const bits = [`这一周说了 ${s.turns} 轮，平均每轮 ${s.avgParts} 条（最多一次 ${s.maxParts} 条），平均 ${s.avgChars} 字。`];
  if (s.short) bits.push(`其中 ${s.short} 次只说了六个字以内。`);
  if (s.stuck) bits.push(`有 ${s.stuck} 次在连着几条里绕同一件事。`);
  const sit = Object.entries(s.situations || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (sit.length) bits.push(`对话最多的是：${sit.map(([k, n]) => `${k} ${n} 次`).join('、')}。`);
  if (s.refused) bits.push(`有 ${s.refused} 次是短的拒绝（「不行」「算了」这种）。`);
  if (s.topOpen) bits.push(`最常用来开头的是「${s.topOpen.text}」，用了 ${s.topOpen.n} 次。`);
  return `这一周你自己的说话记录（数字是真的，别改，别解释，能引用就引用）：\n${bits.map((b) => `- ${b}`).join('\n')}`;
}
