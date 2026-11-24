// 情绪上来的念头：没头没脑、不讲道理，过一阵会平复，回头看可能就不是那个想法了。
//
// 为什么单独一层：日记是日结、周自述是周结，中间缺了「这一阵我心里在嘀咕什么」。
// 念头要也等日结，就成了事后总结，不是当下的想法。
//
// 两条硬规矩：
//   1. 念头要有来处：情绪/心情是真的上来了才冒，不是随机掉一句。
//   2. 「回头看」必须**晚一点**再问——同一刻编出来的「后来」是假的。
//      所以一个念头两次调用：冒出来一次，平复后一次；两次都留着，她自己能看见前后不一样。

import { dayKeyOf } from './affect/core.js';

export const MIN_GAP_MS = 90 * 60e3;   // 两次念头之间至少隔这么久
export const MAX_PER_DAY = 4;          // 一天最多冒几次
export const TEXT_MAX = 30;
export const TTL_MS = 6 * 3600e3;      // 在上下文里活多久
export const SETTLE_MIN_MS = 45 * 60e3; // 至少过这么久才谈得上「平复」
export const SETTLE_CALM = 0.15;       // 情绪强度掉到这以下 = 平复了
export const PER_MAX = 40;

export const createImpulses = () => ({ at: 0, lines: [] });

const hourMin = (ms) => {
  const d = new Date(Number(ms) || 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 今天已经冒过几个念头。 */
export const countToday = (imp, now) => (imp?.lines || []).filter((l) => dayKeyOf(l.at) === dayKeyOf(now)).length;

/** 该冒念头了吗：情绪真的上来了，而且离上一次够久。 */
export function dueThought(st, imp, now) {
  const last = (imp?.lines || []).at(-1);
  if (last && now - last.at < MIN_GAP_MS) return false;
  if (countToday(imp, now) >= MAX_PER_DAY) return false;
  const e = st?.emotion || {};
  const mood = Number(st?.mood?.v ?? 0.5);
  return Number(e.intensity) >= 0.5 || mood <= 0.3 || mood >= 0.72;
}

/** 该回头看一眼了吗：挑最早那个还没回头、且真的过了够久的。 */
export function dueSettle(imp, st, now) {
  const open = (imp?.lines || []).filter((l) => !l.settled);
  if (!open.length) return null;
  const calm = Number(st?.emotion?.intensity ?? 0) < SETTLE_CALM;
  return open.find((l) => now - l.at >= SETTLE_MIN_MS && (calm || now - l.at >= 3 * 3600e3)) || null;
}

const moodWord = (v) => (v >= 0.7 ? '不错' : v >= 0.4 ? '平常' : '有点低');

/** 冒出念头时问她的那句。素材只有真实状态，不给她塞话题。 */
export function thoughtPrompt(st, { now = 0, extra = '' } = {}) {
  const e = st?.emotion || {};
  const mood = Number(st?.mood?.v ?? 0.5);
  const v = Number(e.v ?? 0.5);
  const label = String(e.label || '');
  const lean = v >= 0.6 ? '往好处想' : v <= 0.4 ? '往坏处想' : '';
  return [
    `现在 ${hourMin(now)}。你的心情${moodWord(mood)}${label ? `，刚才${label}` : ''}。`,
    '这种时候人会突然冒出一个念头：没头没脑、不讲道理，可能就是一句嘀咕。',
    `写一个你此刻真的会冒出来的念头，第一人称，不超过 ${TEXT_MAX} 字。`,
    lean ? `情绪上头的时候人就是会${lean}——别替自己找补。` : '',
    '不要解释、不要总结、不要讲道理、不要安慰自己，也不要写成会发给他的话。',
    extra ? `${extra}` : '',
    '真没什么可想的，就只写两个字：没有。',
  ].filter(Boolean).join('\n');
}

/** 只收一句短话；她回「没有」就是这次不冒。 */
export function parseThought(text) {
  const s = String(text ?? '')
    .replace(/^[\s「『"'（(]+|[\s」』"'）)]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || /^(没有|没什么|算了)[。.．!！…]?$/.test(s)) return '';
  return s.slice(0, TEXT_MAX);
}

/** 记下一个念头。同类越堆越多没用，只留最近 PER_MAX 条。 */
export function applyThought(imp, text, now, { v = 0.5 } = {}) {
  const lines = [...(imp?.lines || []), { at: Number(now), text: String(text).slice(0, TEXT_MAX), v: Number(v), settled: null }];
  return { at: Number(now), lines: lines.slice(-PER_MAX) };
}

/** 平复后问她的那句：把当时那句原样给她看，问她现在怎么想。 */
export function settlePrompt(line, st, now = 0) {
  const mood = Number(st?.mood?.v ?? 0.5);
  const label = String(st?.emotion?.label || '');
  return [
    `${hourMin(line.at)} 你心里冒出来一句：「${line.text}」。`,
    `那时候你${label || '情绪上来了'}。现在过了一阵，情绪下去了：心情${moodWord(mood)}${label ? `，这会儿是${label}` : ''}。`,
    `回头看，你现在的想法是什么？第一人称，不超过 ${TEXT_MAX} 字。`,
    '想法没变就只写两个字：没变。不要解释、不要总结、不要讲道理。',
  ].join('\n');
}

/** 「没变」不算一条新想法，但也要记下来，免得十分钟后又问她一遍。 */
export function parseSettle(text) {
  const s = String(text ?? '')
    .replace(/^[\s「『"'（(]+|[\s」』"'）)]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (/^(没变|一样|还是那样|没想法)[。.．!！…]?$/.test(s)) return '';
  return s.slice(0, TEXT_MAX);
}

export function applySettle(imp, at, text, now) {
  const lines = (imp?.lines || []).map((l) => (l.at === at && !l.settled
    ? { ...l, settled: { at: Number(now), text: String(text || '').slice(0, TEXT_MAX) } }
    : l));
  return { at: Number(now), lines };
}

/**
 * 注入上下文的那一句。只取最新一条：
 *   · 还没回头看 → 「你心里冒出来的」
 *   · 回头看过且真的变了 → 前后两种想法都摆出来（这就是她自己的前后矛盾，不是我们编的）
 */
export function renderImpulses(imp, now = 0) {
  const lines = (imp?.lines || []).filter((l) => Number(l?.at) > 0);
  const latest = lines[lines.length - 1];
  if (!latest || now - latest.at >= TTL_MS) return '';
  const when = hourMin(latest.at);
  const after = latest.settled && latest.settled.text && now - latest.settled.at < TTL_MS ? latest.settled : null;
  if (after) {
    return `【你自己心里前后不一样】${when} 你嘀咕的是「${latest.text}」；后来你觉得「${after.text}」（${hourMin(after.at)}）。两种都是真的，现在说哪种由你。`;
  }
  return `【你心里冒出来的】${when} 你自己嘀咕了一句：「${latest.text}」。不用说出来，但它在你心里。`;
}
