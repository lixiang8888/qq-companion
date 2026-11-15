// 感知记忆的检索：先便宜地召回，再让模型真看图确认。
//
// 两段式是这套东西的核心：文字召回负责「别漏」，模型复核负责「别认错」。
// 只做第一段会认错图（一次都不提还更好），只做第二段会每轮都付一次看图的钱。

import { search } from '../memory/search.js';
import { slotsText } from './slots.js';

/** 什么时候值得去翻图：他用的必须是指代，不是随便提到「图」这个字。 */
export const RECALL_TRIGGER = /那张|这张|图|照片|截图|上次发的|刚才发的|看到的|图里|画面/;

/** 召回门槛。search() 会乘重要度(缺省 0.75)和清晰度(缺省 0.5)，所以绝对分被压到三成多。 */
// 实测定标：真命中（「粉头发的那张图」对「粉发女孩」）得 0.22，无关词得 0。取 0.15。
export const MIN_SCORE = 0.15;

export const RECHECK_MAX_PER_HOUR = 5;
const HOUR = 3600e3;

export function shouldRecall(text) {
  return RECALL_TRIGGER.test(String(text || ''));
}

/**
 * 文字召回候选。给记录补一个 text（标题+描述+槽），喂给记忆那套 2-gram BM25。
 * @returns {object[]} 原记录，按分排序；门槛不过返回空数组
 */
export function candidates(records = [], query = '', { now = 0, limit = 5, minScore = MIN_SCORE } = {}) {
  const withText = records.map((rec) => ({ ...rec, text: slotsText(rec) }));
  const hits = search(withText, query, { now, limit });
  if (!hits.length || hits[0].score < minScore) return [];
  return hits.map((h) => records.find((r) => r.id === h.rec.id) || h.rec);
}

/** 复核：一次把候选图交给模型，只许回一个数字。 */
export const RECHECK_PROMPT = '这几张图里，哪一张是他说的那件事？只回一个数字，第几张就从 1 开始数；都不是就回 0。不要解释。';

/** 读它的结论：1..n 是选中的第几张，0 或读不懂都算「都没选中」。 */
export function parsePick(text, n = 1) {
  const s = String(text || '');
  const m = s.match(/\{\s*"pick"\s*:\s*(\d+)/) || s.match(/-?\d+/);
  const k = m ? Number(m[1] ?? m[0]) : 0;
  return Number.isInteger(k) && k >= 1 && k <= n ? k : 0;
}

/** 限流：每小时最多 5 次复核，超了就只做第一段。 */
export function canRecheck(state = {}, now = 0) {
  const list = (state?.at || []).filter((t) => Number(now) - Number(t) < HOUR);
  return list.length < RECHECK_MAX_PER_HOUR;
}

export function noteRecheck(state = {}, now = 0) {
  const list = (state?.at || []).filter((t) => Number(now) - Number(t) < HOUR);
  return { at: [...list, Number(now) || 0] };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 注入的那一行。≤60 字，带日期时刻和来源。 */
export function perceptionLine(rec = {}, now = 0) {
  const at = Number(rec.at) || Number(now) || 0;
  const d = new Date(at);
  const when = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const who = rec.source === 'hers' ? '你自己看到的' : '他发的';
  const title = String(rec.title || '').trim() || String(rec.desc || '').trim().slice(0, 30) || '一张没起名的图';
  return `- ${when} ${who}：${title}`;
}
