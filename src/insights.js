// 每周一次的自述：日有日记，月有人格漂移，中间缺一层「我最近对他什么看法」。
//
// 三类固定（work / us / growth），各有界、各自取最新一句——让模型自由发挥会写成小作文。
// 素材只有记忆卡里的真事；写不出来就写「-」，我们不替她填。

import { rankForPrompt } from './memory/card.js';

export const WEEK_MS = 7 * 86400e3;
// 「你最近的想法」能叫「最近」的时限。周更一次，所以两周 = 漏了一轮还能用，
// 漏两轮就不该再自称「最近」了——那时她已经变了，旧的那句是假的。
export const INSIGHT_TTL = 14 * 86400e3;
export const PER_KIND_MAX = 20;
const TEXT_MAX = 40;
export const KINDS = ['work', 'us', 'growth'];
const LABEL = { work: '我最近', us: '我们', growth: '我学到' };

export function createInsights() {
  return { at: 0, lines: [] };
}

/** 距上次 ≥7 天（或者从来没写过）。 */
export function dueInsights(ins, now) {
  const at = Number(ins?.at) || 0;
  return !at || now - at >= WEEK_MS;
}

/** 只认 `kind|内容` 这种行；别的一律丢——模型爱加解释，解释不该进她的脑子。 */
export function parseInsights(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*>\s]+/, '');
    const m = line.match(/^(work|us|growth)\s*[|｜]\s*(.+)$/i);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    const body = m[2].trim().replace(/^[「『"']|[」』"']$/g, '');
    if (!body || body === '-' || body === '—') continue;
    if (seen.has(kind)) continue; // 同类只留第一句
    seen.add(kind);
    out.push({ kind, text: body.slice(0, TEXT_MAX) });
  }
  return out;
}

/** 追加到自己的历史里：同类最多 20 条，留最新的；同样的句子不重复记。 */
export function applyInsights(ins, lines, now) {
  const prev = Array.isArray(ins?.lines) ? ins.lines : [];
  const fresh = (lines || [])
    .filter((l) => KINDS.includes(l.kind) && l.text && !prev.some((p) => p.kind === l.kind && p.text === l.text))
    // 每句带自己的时刻：整份文件只记「上次什么时候写的」，一句可能是三周前写的。
    .map((l) => ({ kind: l.kind, text: l.text, at: now }));
  let next = [...prev, ...fresh];
  for (const kind of KINDS) {
    const mine = next.filter((l) => l.kind === kind);
    if (mine.length > PER_KIND_MAX) {
      const drop = new Set(mine.slice(0, mine.length - PER_KIND_MAX));
      next = next.filter((l) => !drop.has(l));
    }
  }
  return { at: now, lines: next };
}

/** 这一句写于何时。老文件没有逐句的时刻，就退回整份文件的时刻。 */
export const lineAt = (line, ins) => Number(line?.at) || Number(ins?.at) || 0;

/** 她最近的想法里，最新那句写于何时（给上下文块当 at 用）。 */
export function insightsLastAt(ins) {
  return (ins?.lines || []).reduce((max, l) => Math.max(max, lineAt(l, ins)), 0);
}

/**
 * 注入用：三类各取最新一句，拼成一行。没有就返回空串（不写占位句）。
 * @param {number} [now] 现在。过了 INSIGHT_TTL 的句子不再算「最近的想法」，直接丢掉。
 */
export function renderInsights(ins, now = 0) {
  const t = Number(now) || Number(ins?.at) || 0;
  const alive = (l) => !(t && t - lineAt(l, ins) >= INSIGHT_TTL);
  const parts = [];
  for (const kind of KINDS) {
    const mine = (ins?.lines || []).filter((l) => l.kind === kind && alive(l));
    if (!mine.length) continue;
    parts.push(`${LABEL[kind]}：${mine[mine.length - 1].text}`);
  }
  if (!parts.length) return '';
  return `【你最近的想法】${parts.join('；')}`;
}

/** 拼给她的提示词。一条记忆都没有就不问——没东西可想的时候硬想，只会想出假话。 */
export function composePrompt(card, { now = 0, limit = 12, extra = '' } = {}) {
  const picks = rankForPrompt(card, { now }).slice(0, limit).filter((r) => r?.text);
  if (!picks.length) return '';
  // 行为统计是可选的：没有账本（或这一周没说话）就跟以前一样只拿记忆说话。
  const behavior = String(extra || '').trim();
  return `你一个人待着的时候，回头想了想最近。
你记得这些事：
${picks.map((r) => `- ${r.text}`).join('\n')}
${behavior ? `\n${behavior}\n` : ''}
只写三行，每行一个类别，格式「类别|一句不超过 40 字的话」：
work|我最近是怎么过的/怎么对她的
us|我们现在是什么关系、我怎么看我们
growth|我学到了什么、哪里变了
${behavior ? '上面有数字的话，这一行尽量用上它——写「这周我有 12 次在说同一个意思」，比写「我要更用心」有用。' : ''}
写不出来那一类就写「-」。不要编，不要总结成道理，不要提这是你被要求写的。`;
}
