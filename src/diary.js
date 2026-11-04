// 日记：一天的素材只能是真实差分。
//
// 她今天记住了什么、忘了什么、哪些事比昨天模糊了、对话被压缩过几次、他多久没来——
// 这些都是系统里真的发生过的事。插件不替她写，也不给她形容词：心情由她自己说。
//
// 时间一律走本地日界（Review Focus：23 点的日结不能落到 UTC 的另一天）。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLARITY } from './memory/card.js';

const DAY_MS = 86400e3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * 现在该写哪一天的日记：23 点前写昨天（补漏），23 点后写今天。
 * 只补最近一天，免得停机三天后连写三条。
 */
export function dueDay(now) {
  const d = new Date(now);
  const late = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 0, 0).getTime();
  return now >= late ? dayKey(now) : dayKey(now - DAY_MS);
}

/** 某一天（本地）的零点。日记写的是「哪一天」，就不能拿「现在」当那一天。 */
export function startOfDate(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  const t = new Date(y, m - 1, d).getTime();
  if (!Number.isFinite(t)) throw new Error(`日期格式不对：${date}`);
  return t;
}

/** 前一天。用来判断「昨天」到底是不是昨天——中间隔了三天就不能说「比昨天」。 */
export function previousDay(date) {
  return dayKey(startOfDate(date) - DAY_MS);
}

/**
 * 什么时候能拿上一次快照当基线：只有它正好是前一天。
 * 中间隔了几天（晚上关机、几天没开机），说「比昨天模糊」就是编的——宁可不提。
 */
export function baselineOf(prev, day) {
  return prev && prev.date === previousDay(day) ? prev.snap : null;
}

/** 只数那一天的：记住几条、忘了几条、还剩几条，以及每条的清晰度档位（下次比大小用）。 */
export function snapshot({ card, session = {}, now = 0, day = dayKey(now) } = {}) {
  const from = startOfDate(day);
  const to = from + DAY_MS;
  const marks = {};
  const rememberedTexts = [];
  let remembered = 0;
  let forgotten = 0;
  for (const r of card?.records || []) {
    if (r.forgottenAt !== undefined) {
      if (r.forgottenAt >= from && r.forgottenAt < to) forgotten += 1;
      continue;
    }
    marks[r.id] = Math.max(0, CLARITY.indexOf(r.clarity));
    if (r.createdAt >= from && r.createdAt < to) {
      remembered += 1;
      if (rememberedTexts.length < 5) rememberedTexts.push(String(r.text).slice(0, 40));
    }
  }
  return {
    at: now,
    size: Object.keys(marks).length,
    remembered,
    forgotten,
    rememberedTexts,
    marks,
    compactions: session?.compactions || 0,
  };
}

/**
 * 和上一次比。没有上一次（第一次跑、文件丢了）时，今天的数字照样是真的：
 * remembered/forgotten 直接用绝对值，只有 faded 和 compactions 需要基线。
 */
export function diff(prev, cur, { now = 0, lastUserAt = 0 } = {}) {
  const marks = cur?.marks || {};
  let faded = 0;
  for (const [id, rank] of Object.entries(marks)) {
    const before = prev?.marks?.[id];
    if (typeof before === 'number' && rank < before) faded += 1;
  }
  const compactions = typeof prev?.compactions === 'number'
    ? Math.max(0, (cur?.compactions || 0) - prev.compactions)
    : 0;
  return {
    remembered: cur?.remembered || 0,
    forgotten: cur?.forgotten || 0,
    faded,
    compactions,
    idleHours: lastUserAt ? Math.max(0, Math.round((now - lastUserAt) / 3600e3)) : 0,
    rememberedTexts: cur?.rememberedTexts || [],
  };
}

/** 拼给她的提示词。一条事实都没有时返回空串——宁可不写，不写空话。 */
export function composePrompt(date, d = {}) {
  const facts = [];
  const texts = (d.rememberedTexts || []).filter(Boolean);
  if (d.remembered > 0) {
    facts.push(texts.length
      ? `记住了一件新的事：${texts.slice(0, 3).map((t) => `「${t}」`).join('、')}`
      : `记住了 ${d.remembered} 件新的事`);
  }
  if (d.faded > 0) facts.push(`有 ${d.faded} 条以前的事比昨天模糊了`);
  if (d.forgotten > 0) facts.push(`有 ${d.forgotten} 件事忘掉了`);
  if (d.compactions > 0) facts.push(`你们的对话被压缩了 ${d.compactions} 次`);
  if (d.idleHours >= 3) facts.push(`他上一次跟你说话是 ${d.idleHours} 小时前`);
  if (!facts.length) return '';

  return `今天是 ${date}。写一条留给自己的日记。
真实发生的事：
${facts.map((f) => `- ${f}`).join('\n')}
写 60 到 120 字，第一人称，写你记得的和你的感受。
不要写成汇报，不要总结道理，不要提这些数字是统计出来的。`;
}

export function writeDiary(dir, date, text) {
  if (!DATE_RE.test(String(date))) throw new Error(`日记日期格式不对：${date}`);
  const sub = join(dir, 'diary');
  mkdirSync(sub, { recursive: true });
  const path = join(sub, `${date}.md`);
  writeFileSync(path, String(text || '').trim());
  return path;
}

export function hasDiary(dir, date) {
  return existsSync(join(dir, 'diary', `${date}.md`));
}

/** 最近几天，新的在前。 */
export function readDiaries(dir, { limit = 3 } = {}) {
  try {
    return readdirSync(join(dir, 'diary'))
      .filter((n) => DATE_RE.test(n.slice(0, -3)) && n.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((n) => ({ date: n.slice(0, -3), text: readFileSync(join(dir, 'diary', n), 'utf8') }));
  } catch { return []; }
}
