// 人格怎么会变：不是每吵一次架就改性格，而是「同一个模式出现足够多次、跨足够多天」才结算一次。
//
// 两条闸（手册 §10.2）：
//   触发：同 pattern ≥5 次且跨度 ≥3 天；
//   节奏：一个月只结算一次（小时级更新那叫噪声，不叫人格）。
// 结算时留快照（最多 20 版），可以回滚；回滚只动特质，不删记忆。

import { DAY_MS, TRAITS, TRAIT_BASE, applyDrift, monthOf } from './core.js';

export const SNAPSHOT_MAX = 20;
export const PATTERN_HITS = 5;
export const PATTERN_SPAN_DAYS = 3;

const WORD = {
  sensitivity: ['更敏感了', '没那么在意细节了'],
  aggression: ['更容易顶回去了', '更懒得争了'],
  resilience: ['恢复得更快了', '更容易把事记在心里了'],
  openness: ['更容易对新东西来劲了', '对新东西没那么起劲了'],
  attachment: ['更在意他理不理我了', '没那么黏人了'],
};

/** 记一次模式：不直接改特质，只累积证据。 */
export function notePattern(st, key, deltas, now) {
  const next = structuredClone(st);
  const s = next.self;
  s.patterns = s.patterns || {};
  const p = s.patterns[key] || { hits: 0, firstAt: now, lastAt: now, deltas: {} };
  p.hits += 1;
  p.lastAt = now;
  for (const [k, d] of Object.entries(deltas || {})) {
    if (!TRAITS.includes(k) || !Number.isFinite(d)) continue;
    p.deltas[k] = (p.deltas[k] || 0) + d;
  }
  s.patterns[key] = p;
  return next;
}

export function eligiblePatterns(st, now) {
  const out = [];
  for (const [key, p] of Object.entries(st.self.patterns || {})) {
    const span = Math.max(0, (p.lastAt - p.firstAt) / DAY_MS);
    if (p.hits >= PATTERN_HITS && (span >= PATTERN_SPAN_DAYS || now - p.firstAt >= PATTERN_SPAN_DAYS * DAY_MS)) {
      out.push({ key, ...p });
    }
  }
  return out.sort((a, b) => b.hits - a.hits);
}

/**
 * 月度结算：一个月只跑一次；取最明显的两个模式合并成一次漂移。
 * @returns {{state, changed: boolean, applied: object, narrative: string}}
 */
export function monthlyDrift(st, now) {
  const month = monthOf(now);
  const next = structuredClone(st);
  next.self = next.self || {};
  next.self.monthKey = next.self.monthKey || month;
  if (next.self.monthKey === month) return { state: next, changed: false, applied: {}, narrative: next.self.narrative || '' };

  const picked = eligiblePatterns(next, now).slice(0, 2);
  next.self.monthKey = month;
  if (!picked.length) return { state: next, changed: false, applied: {}, narrative: next.self.narrative || '' };

  const deltas = {};
  for (const p of picked) for (const [k, d] of Object.entries(p.deltas || {})) deltas[k] = (deltas[k] || 0) + d / Math.max(1, p.hits);
  const before = snapshotOf(next, now);
  const { state: drifted, applied } = applyDrift(next, deltas, now);
  const narrative = narrativeOf(applied);
  drifted.self.narrative = narrative || drifted.self.narrative;
  drifted.self.snapshots = [...(before ? [before] : []), ...(next.self.snapshots || [])].slice(0, SNAPSHOT_MAX);
  // 结算过的模式清零，避免下个月同一件事再涨一次。
  drifted.self.patterns = {};
  return { state: drifted, changed: Object.keys(applied).length > 0, applied, narrative };
}

function snapshotOf(st, now) {
  const traits = {};
  for (const k of TRAITS) traits[k] = st.self[k];
  return { at: now, traits, narrative: st.self.narrative || '' };
}

function narrativeOf(applied) {
  const bits = Object.entries(applied).map(([k, d]) => (WORD[k] || ['变了', '变了'])[d > 0 ? 0 : 1]);
  return bits.length ? `我最近${bits.join('，')}` : '';
}

/** 回滚到某一版快照（只动特质，不动记忆）。 */
export function rollbackTraits(st, at) {
  const next = structuredClone(st);
  const snap = (next.self.snapshots || []).find((s) => s.at === at);
  if (!snap) return { state: next, ok: false };
  for (const k of TRAITS) if (Number.isFinite(snap.traits?.[k])) next.self[k] = snap.traits[k];
  next.self.narrative = snap.narrative || '';
  next.self.snapshots = (next.self.snapshots || []).filter((s) => s.at !== at);
  return { state: next, ok: true };
}

export function traitLine(st) {
  const off = TRAITS
    .map((k) => [k, st.self[k]])
    .filter(([k, v]) => Math.abs(v - TRAIT_BASE[k]) >= 0.05)
    .map(([k, v]) => (WORD[k] || ['变了', '变了'])[v > TRAIT_BASE[k] ? 0 : 1]);
  return off.length ? `（你最近${off.join('，')}）` : '';
}
