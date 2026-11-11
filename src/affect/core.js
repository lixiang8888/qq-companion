// 四层状态：情绪(分钟) → 心境(天) → 关系(周月) → 人格(月年)。
//
// 为什么全是纯函数 + 注入时钟：手册 §9.5 要求「同一事件序列重放两次，状态哈希一致」。
// 只要不读 Date.now()、不写文件，重放就成立，测试也不需要假时钟库。
//
// 数值全部是设计选择（手册标 [设]），不是实证常数；改名时请连注释一起改。

import { createHash } from 'node:crypto';

export const EMOTION_HALF_MS = 30 * 60e3;      // 情绪强度半衰期
export const MOOD_DECAY_MS = 24 * 3600e3;      // 心境回落基线
export const MOOD_FOLLOW_MS = 8 * 3600e3;      // 心境跟随当前情绪
export const REPAIR_HALF_MS = 4 * 86400e3;     // 修复：按残余比例，半衰期 3~5 天取中
export const GUARD_QUIET_MS = 30 * 86400e3;    // 连续 30 天无伤害，guard 才开始回落
export const GUARD_STEP = 0.01;                // 每月回落
export const GUARD_MAX = 0.7;
export const DAMAGE_SINGLE_MAX = 0.1;
export const DAMAGE_DAY_MAX = 0.1;
export const WARM_SINGLE_MAX = 0.02;
export const WARM_DAY_MAX = 0.05;
export const DRIFT_HITS = 5;                   // 同 pattern ≥5 次
export const DRIFT_SPAN_DAYS = 3;              // 且跨 ≥3 天
export const DRIFT_STEP_MAX = 0.02;
export const DRIFT_DAY_MAX = 0.05;
export const PULLBACK_PER_DAY = 0.015;
export const BASELINE = { v: 0.5, a: 0.3 };
export const TRAIT_BASE = { sensitivity: 0.5, aggression: 0.3, resilience: 0.5, openness: 0.6, attachment: 0.5 };
export const TRAITS = Object.keys(TRAIT_BASE);
export const DAY_MS = 86400e3;

// 「一天」按**本地**午夜分界，不是 UTC：用 toISOString 的话，中国用户的每日上限会在早上 8 点
// 悄悄重置，而真正的午夜（她最常被聊的时候）反而不算新的一天。
const pad2 = (n) => String(n).padStart(2, '0');
export const monthOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};
export const dayKeyOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

export const clamp = (x, lo = 0, hi = 1) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);
const decay = (dtMs, halfMs) => Math.pow(0.5, Math.max(0, dtMs) / halfMs);

export function initState(now = 0) {
  return {
    version: 1,
    emotion: { v: BASELINE.v, a: BASELINE.a, intensity: 0, at: now },
    mood: { v: BASELINE.v, a: BASELINE.a, at: now },
    relation: {
      trust: 0.5, intimacy: 0.4, guard: 0.2, debt: 0,
      residual: 0, lastDamageAt: 0, guardMonths: 0,
      dayKey: dayKeyOf(now), dayDamage: 0, dayWarmth: 0,
    },
    self: {
      ...TRAIT_BASE, at: now, dayKey: dayKeyOf(now), dayDrift: 0, driftVersion: 0,
      patterns: {}, snapshots: [], monthKey: monthOf(now),
    },
  };
}

/**
 * 惰性结算到 now：所有层按时间差一次性算到位，不每轮写。
 * 重复调用是幂等的（同一 now 调两次结果相同）。
 */
export function settle(st, now) {
  const next = structuredClone(st);
  // 心境要跟着「这段时间里发生过的情绪」走，所以先留一份结算前的快照。
  const before = { ...next.emotion };
  settleEmotion(next, now);
  settleMood(next, now, before);
  settleRelation(next, now);
  settleSelf(next, now);
  return next;
}

function settleEmotion(st, now) {
  const e = st.emotion;
  const dt = now - e.at;
  if (dt <= 0) return;
  const f = decay(dt, EMOTION_HALF_MS);
  e.intensity = e.intensity * f;
  e.v = BASELINE.v + (e.v - BASELINE.v) * f;
  e.a = BASELINE.a + (e.a - BASELINE.a) * f;
  if (e.intensity < 0.01) {
    e.intensity = 0;
    e.v = BASELINE.v;
    e.a = BASELINE.a;
  }
  e.at = now;
}

function settleMood(st, now, before = st.emotion) {
  const m = st.mood;
  const dt = now - m.at;
  if (dt <= 0) return;
  // 情绪够强时心境跟过去，平时自己回基线；用结算前的强度判断，否则隔夜结算会把当天的情绪当成没发生。
  const follow = before.intensity >= 0.3;
  const target = follow ? { v: before.v, a: before.a } : BASELINE;
  const f = decay(dt, follow ? MOOD_FOLLOW_MS : MOOD_DECAY_MS);
  m.v = target.v + (m.v - target.v) * f;
  m.a = target.a + (m.a - target.a) * f;
  m.at = now;
}

function settleRelation(st, now) {
  const r = st.relation;
  const dt = now - (Number(r.lastSettleAt) || Number(r.lastDamageAt) || now);
  if (!(dt > 0)) return; // 时钟回拨：不推进结算点，避免把残余洗成负数
  if (r.residual > 0) {
    const prev = r.residual;
    r.residual = prev * decay(dt, REPAIR_HALF_MS);
    // 修复只按「已经淡掉的那部分」回信任：guard 不动，忘了不等于原谅（手册 §9.2）。
    const recovered = prev - r.residual;
    r.trust = clamp(r.trust + recovered * 0.8, 0, 0.95);
  }
  r.lastSettleAt = now;
  // guard 回落：只认「连续无伤害的整月」，用计数器保证幂等，不靠每次乘系数。
  if (r.lastDamageAt > 0 && now - r.lastDamageAt >= GUARD_QUIET_MS) {
    const months = Math.floor((now - r.lastDamageAt - GUARD_QUIET_MS) / (30 * DAY_MS)) + 1;
    if (months > r.guardMonths) {
      r.guard = clamp(r.guard - (months - r.guardMonths) * GUARD_STEP, 0, GUARD_MAX);
      r.guardMonths = months;
    }
  }
}

function settleSelf(st, now) {
  const s = st.self;
  const dt = now - s.at;
  if (dt <= 0) return;
  const days = dt / DAY_MS;
  const f = Math.pow(1 - PULLBACK_PER_DAY, days); // 每天向基线回拉 1.5%
  for (const k of TRAITS) s[k] = TRAIT_BASE[k] + (s[k] - TRAIT_BASE[k]) * f;
  s.at = now;
  const day = dayKeyOf(now);
  if (s.dayKey !== day) {
    s.dayKey = day;
    s.dayDrift = 0;
  }
}

/**
 * 一个情绪事件。intensity 是本轮刺激的强度（0~1），累计不超过 2 档。
 * 用语用层（句长、语气词、接梗）表达，不说出口——注入文本里会再强调一次。
 */
export function pushEmotion(st, { v, a, intensity = 0.5 }, now) {
  const next = settle(st, now);
  const e = next.emotion;
  const k = clamp(0.25 + 0.25 * intensity, 0.25, 0.6);
  e.v = clamp(e.v + (clamp(v) - e.v) * k);
  e.a = clamp(e.a + (clamp(a) - e.a) * k);
  e.intensity = clamp(e.intensity + clamp(intensity), 0, 2);
  e.at = now;
  return next;
}

/** 伤害：单次 ≤0.10、单日 ≤0.10，guard 只升不降（回落见 settleRelation）。返回本次实际生效量。 */
export function applyDamage(st, weight, now) {
  const next = settle(st, now);
  const r = next.relation;
  const day = dayKeyOf(now);
  if (r.dayKey !== day) {
    r.dayKey = day;
    r.dayDamage = 0;
  }
  const budget = Math.max(0, DAMAGE_DAY_MAX - r.dayDamage);
  const d = Math.min(clamp(weight, 0, DAMAGE_SINGLE_MAX), budget);
  if (d <= 0) return { state: next, applied: 0 };
  r.guard = clamp(r.guard + d, 0, GUARD_MAX);
  r.trust = clamp(r.trust - d * 0.8, 0, 1);
  r.intimacy = clamp(r.intimacy - d * 0.2, 0, 1);
  r.residual += d;
  r.dayDamage += d;
  r.lastDamageAt = now;
  return { state: next, applied: d };
}

/** 正向的一次「被认真对待」：信任和亲密能涨，但一天封顶，且不碰 guard（戒备只能靠时间回落）。 */
export function applyWarmth(st, weight, now) {
  const next = settle(st, now);
  const r = next.relation;
  const day = dayKeyOf(now);
  if (r.dayKey !== day) {
    r.dayKey = day;
    r.dayDamage = 0;
    r.dayWarmth = 0;
  }
  const budget = Math.max(0, WARM_DAY_MAX - (r.dayWarmth || 0));
  const w = Math.min(clamp(weight, 0, WARM_SINGLE_MAX), budget);
  if (w <= 0) return { state: next, applied: 0 };
  r.trust = clamp(r.trust + w, 0, 0.95);
  r.intimacy = clamp(r.intimacy + w * 0.6, 0, 0.95);
  r.dayWarmth = (r.dayWarmth || 0) + w;
  return { state: next, applied: w };
}

/** 人格能不能漂：同 pattern ≥5 次且跨 ≥3 天（手册 §10.2）。 */
export function canDrift({ hits, spanDays }) {
  return Number(hits) >= DRIFT_HITS && Number(spanDays) >= DRIFT_SPAN_DAYS;
}

/** 漂移：单次 |Δ|≤0.02，日累计 Σ|Δ|≤0.05。返回实际生效的增量。 */
export function applyDrift(st, deltas, now) {
  const next = settle(st, now);
  const s = next.self;
  const day = dayKeyOf(now);
  if (s.dayKey !== day) {
    s.dayKey = day;
    s.dayDrift = 0;
  }
  let budget = Math.max(0, DRIFT_DAY_MAX - s.dayDrift);
  const applied = {};
  for (const [k, raw] of Object.entries(deltas || {})) {
    if (!TRAITS.includes(k) || !Number.isFinite(raw)) continue;
    const want = Math.min(Math.abs(raw), DRIFT_STEP_MAX) * Math.sign(raw);
    const d = Math.sign(want) * Math.min(Math.abs(want), budget);
    if (!d) continue;
    s[k] = clamp(s[k] + d, 0.05, 0.95);
    applied[k] = d;
    budget -= Math.abs(d);
    s.dayDrift += Math.abs(d);
  }
  if (Object.keys(applied).length) {
    s.driftVersion += 1;
    s.at = now;
  }
  return { state: next, applied };
}

/** 心境分桶 + 滞回：桶内不重排，跨桶才重排（手册 §7.4）。 */
export function moodBucket(st, { width = 0.1, prev = null, hyst = 0.02 } = {}) {
  const v = st.mood.v;
  const at = Math.floor(v / width);
  if (prev != null) {
    const prevCenter = prev * width + width / 2;
    if (Math.abs(v - prevCenter) < hyst) return prev;
  }
  return at;
}

/** 稳定哈希：键排序 + 只取状态本体，用于重放一致性判据。 */
export function stateHash(st) {
  const canon = JSON.stringify(sortKeys(st));
  return createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value;
}
