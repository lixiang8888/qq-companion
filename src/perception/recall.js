// 感知记忆的检索：先便宜地召回，再让模型真看图确认。
//
// 两段式是这套东西的核心：文字召回负责「别漏」，模型复核负责「别认错」。
// 只做第一段会认错图（一次都不提还更好），只做第二段会每轮都付一次看图的钱。
//
// 触发不看关键词：发完图之后聊别的，他那句里一个字都不带「图」，靠词汇表就等于永远想不起来。

import { search } from '../memory/search.js';
import { slotsText } from './slots.js';

/** 召回门槛。search() 会乘重要度(缺省 0.75)和清晰度(缺省 0.5)，所以绝对分被压到三成多。 */
// 实测定标：真命中（「粉头发的那张图」对「粉发女孩」）得 0.22，无关词得 0。取 0.15。
export const MIN_SCORE = 0.15;

/** 超过这个分，就不只是"提一句"，而是把图贴回去让她重看一遍。 */
export const REOPEN_SCORE = 0.4;

export const RECHECK_MAX_PER_HOUR = 5;
const HOUR = 3600e3;

/**
 * 文字召回候选。给记录补一个 text（标题+描述+槽），喂给记忆那套 2-gram BM25。
 * @returns {object[]} 原记录，按分排序；门槛不过返回空数组
 */
export function candidates(records = [], query = '', { now = 0, limit = 5, minScore = MIN_SCORE } = {}) {
  const withText = records.map((rec) => ({ ...rec, text: slotsText(rec) }));
  const hits = search(withText, query, { now, limit });
  if (!hits.length || hits[0].score < minScore) return [];
  // 带上分数：调用方要按「够不够高」决定是提一句还是把图贴回去重看。
  return hits.map((h) => ({ rec: records.find((r) => r.id === h.rec.id) || h.rec, score: h.score }));
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

// 近窗口：这段时间里他发过的图不算"回忆"，它们还是当前话题的一部分。
export const RECENT_MS = 24 * 3600e3;
export const RECENT_TURNS = 30;
export const RECENT_MAX = 3;

/**
 * 近窗口里的图。两条判据取并集：够新（24 小时内），或者出现在最近 30 轮对话里。
 * 只看窗口、不检索——刚聊过的东西不需要"找"。
 */
export function recentShots(records = [], { now = 0, history = [], max = RECENT_MAX } = {}) {
  const cut24 = Number(now) - RECENT_MS;
  const tail = (history || []).slice(-RECENT_TURNS);
  const cutTurns = tail.length ? Number(tail[0]?.at) || 0 : 0;
  const since = cutTurns ? Math.min(cut24, cutTurns) : cut24;
  return (records || [])
    .filter((r) => (Number(r.at) || 0) >= since)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .slice(0, max);
}

const hhmm = (ms) => {
  const d = new Date(Number(ms) || 0);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** 近窗口那一行：用完整描述，不是标题——当下聊的就是它。 */
export function recentLine(rec = {}, now = 0) {
  const desc = String(rec.desc || rec.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const who = rec.source === 'hers' ? '你自己看到的' : '他发的';
  return `- ${hhmm(rec.at || now)} ${who}：${desc || '一张没起名的图'}`;
}

/**
 * 注入的那一行。≤60 字，带日期时刻和来源。
 */
export function perceptionLine(rec = {}, now = 0) {
  const at = Number(rec.at) || Number(now) || 0;
  const d = new Date(at);
  const when = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const who = rec.source === 'hers' ? '你自己看到的' : '他发的';
  const title = String(rec.title || '').trim() || String(rec.desc || '').trim().slice(0, 30) || '一张没起名的图';
  return `- ${when} ${who}：${title}`;
}
