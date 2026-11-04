// 记忆卡：会模糊、会遗忘、但重要的东西永远在。
//
// 规则不是拍脑袋：照 SurfCore 的 MEMORY_CARD.md（MIT）实现的最小版——
//   四档清晰度、每天最多降一档、停机按天补跑、置顶/初次/主人重要记忆有下限。
// 我们没有照抄它的 90KB，只留判定链；数字可调，测试钉住的是「形状」不是绝对值。

import { createHash } from 'node:crypto';
import { search } from './search.js';

export const DAY_MS = 86400e3;
export const CLARITY = ['trace', 'fuzzy', 'clear', 'vivid']; // 0..3，越高越清楚
export const CLARITY_LABEL = { trace: '只剩印象', fuzzy: '模糊', clear: '清楚', vivid: '清晰' };

const EMOTION_WORDS = ['喜欢', '想你', '爱', '难过', '委屈', '哭', '抱抱', '对不起', '谢谢', '陪我', '永远', '舍不得', '开心'];
const FIRST_WORDS = ['第一次', '初次', '头一次', '最早', '刚认识', '纪念日'];
const PROMISE_WORDS = ['答应', '约定', '说好', '以后', '下次', '记得', '不要忘', '发誓'];
const CONFLICT_WORDS = ['吵架', '生气', '道歉', '和好', '误会', '冷战'];

const hits = (text, words) => words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);

/**
 * 重要度：纯函数、不调模型。
 * 主人私聊 +42 / 群里 +32，情绪浓度 +0~24，第一次 +30，约定 +16，矛盾 +14。
 */
export function scoreMemory(text, { owner = false, inGroup = false, direct = false } = {}) {
  const t = String(text || '');
  let score = 8;
  if (owner) score += inGroup ? 32 : 42;
  if (direct) score += 8;
  const emo = hits(t, EMOTION_WORDS);
  const bangs = (t.match(/[！!]/g) || []).length;
  score += Math.min(24, emo * 8 + Math.min(2, bangs));
  const isFirst = hits(t, FIRST_WORDS) > 0;
  if (isFirst) score += 30;
  score += hits(t, PROMISE_WORDS) * 8;
  score += hits(t, CONFLICT_WORDS) * 7;
  if (/我(喜欢|是|的)/.test(t)) score += 5;
  if (t.replace(/\s/g, '').length < 6) score -= 12;
  return { score: Math.max(1, Math.min(100, score)), isFirst, emotional: emo * 8 };
}

export function createCard(now = 0) {
  return { version: 1, records: [], stats: { forgotten: 0 }, lastDecayAt: now };
}

// 记忆分三类。不分类的代价是实测出来的：400 天、3000 条封顶之后，
// 「我对花生过敏」会被日常闲聊挤出去（10 条长期事实只剩 2 条）。
const IDENTITY_WORDS = ['我叫', '我名字', '我住', '我家', '我妈', '我爸', '我哥', '我姐', '我弟', '我妹',
  '我老婆', '我老公', '我对象', '我女朋', '我男朋', '我养', '我生日', '我今年', '我岁', '过敏', '忌口',
  '不能吃', '吃素', '我上班', '我工作', '我公司', '我学校', '我专业', '我学', '我喜欢', '我讨厌',
  '我最', '我打算', '受伤', '摔', '骨折', '住院', '手术'];
const EVENT_WORDS = ['考试', '面试', '搬家', '出差', '生病', '医院', '手术', '旅行', '旅游', '入职',
  '离职', '毕业', '结婚', '吵架', '和好', '答应', '约定', '说好', '明天', '后天', '下周', '下个月',
  '上周', '昨天', '去年', '今年', '生日'];

/** 关于他是谁 / 关于发生过什么 / 日常闲话。 */
export function classify(text) {
  const t = String(text || '');
  if (IDENTITY_WORDS.some((w) => t.includes(w))) return 'identity';
  if (EVENT_WORDS.some((w) => t.includes(w))) return 'event';
  return 'chatter';
}

const KIND_RANK = { chatter: 0, event: 1, identity: 2 };

// ---- 旧事实失效 ----
// 新句里出现这些词，才有资格让旧记录失效（「团子走了」→「他养了只猫，叫团子」）。
const SUPERSEDE_WORDS = ['走了', '没了', '不在了', '分手', '离职', '搬走', '不养了', '结束了', '换了', '不是了', '去世'];
// 判断「说的是同一件事」用的两字窗里，这些字太常见，不能作为依据。
const COMMON_CHARS = new Set(Array.from('的了是我你他她它们在和有就都很吗吧呢啊呀哦嗯这那今天明天昨天时候然后什么一个'));

/** 还活着的记录：没被遗忘，也没被后来的说法覆盖。 */
export function isLive(rec) {
  return rec?.forgottenAt === undefined && rec?.supersededAt === undefined;
}

function bigrams(s) {
  const out = [];
  const a = Array.from(String(s || ''));
  for (let i = 0; i < a.length - 1; i++) out.push(a[i] + a[i + 1]);
  return out;
}

const meaningful = (bi) => Array.from(bi).every((c) => /[\u4e00-\u9fffA-Za-z0-9]/.test(c))
  && Array.from(bi).some((c) => !COMMON_CHARS.has(c));

/**
 * 新句该让哪条旧记录失效。保守到近乎吝啬：
 *   1. 新句必须带变化词（走了/没了/换了…）；
 *   2. 必须和旧记录共享一个「有实义」的两字窗（团子、面试、杭州）；
 *   3. 锚点（置顶/初次）不动；
 *   4. 一次最多一条，取共享最多的那条。
 * 宁可留两条矛盾的记忆，也不要错误地抹掉一条——覆盖可见、可撤销，但没人会天天去看。
 */
export function findSupersedeTarget(card, text) {
  const t = String(text || '');
  if (!SUPERSEDE_WORDS.some((w) => t.includes(w))) return null;
  const mine = bigrams(t).filter(meaningful);
  if (!mine.length) return null;
  let best = null;
  let bestShared = 0;
  for (const rec of card?.records || []) {
    if (!isLive(rec) || rec.pinned || rec.first) continue;
    const theirs = new Set(bigrams(rec.text));
    const shared = mine.filter((b) => theirs.has(b)).length;
    if (shared > bestShared) { best = rec; bestShared = shared; }
  }
  return best;
}

/** 撤销覆盖：错杀一条记忆比留下两条矛盾的更糟，所以必须能改回来。 */
export function undoSupersede(card, id) {
  const next = structuredClone(card);
  const rec = next.records.find((r) => r.id === id && r.supersededAt !== undefined);
  if (!rec) return next;
  delete rec.supersededAt;
  next.stats = next.stats || {};
  next.stats.superseded = Math.max(0, (next.stats.superseded || 0) - 1);
  return next;
}

/** 记录的目标清晰度：由重要度、被想起次数、最近性、时间惩罚共同决定。 */
export function targetClarity(rec, now) {
  if (rec.pinned || rec.first) return 'vivid';
  // 关于他是谁的东西不会因为"很久没提"就变成只剩印象——那正是陪伴体最该记住的部分。
  if (rec.kind === 'identity') return (now - rec.lastSeenAt) / DAY_MS <= 7 ? 'vivid' : 'clear';
  const days = Math.max(0, (now - rec.createdAt) / DAY_MS);
  const sinceSeen = Math.max(0, (now - rec.lastSeenAt) / DAY_MS);
  let retention = rec.importance
    + Math.min(12, (rec.recallCount || 0) * 2)
    + (sinceSeen <= 7 ? 18 : 0)
    - Math.max(0, days - 7) * (rec.owner ? 0.12 : 0.35);
  if (rec.owner && rec.importance >= 65) retention = Math.max(55, retention);
  if (sinceSeen <= 7) retention = Math.max(50, retention);
  if (days > 60 && rec.importance < 50 && !rec.owner) return 'trace';
  if (retention >= 75) return 'vivid';
  if (retention >= 50) return 'clear';
  if (retention >= 25) return 'fuzzy';
  return 'trace';
}

const rank = (c) => Math.max(0, CLARITY.indexOf(c));
const ofRank = (r) => CLARITY[Math.max(0, Math.min(3, r))];

/**
 * 每日整理：按错过天数逐日降档（最多补 30 天），一天最多降一档。
 * 被再次提到会更新 lastSeenAt，第二天可能回升——回升不受「每天一档」限制。
 */
export function maintain(card, now) {
  const next = structuredClone(card);
  const missed = Math.floor((now - (next.lastDecayAt || now)) / DAY_MS);
  if (missed <= 0) return next;
  const steps = Math.min(30, missed);
  for (let i = 1; i <= steps; i++) {
    const at = (next.lastDecayAt || now) + i * DAY_MS;
    for (const rec of next.records) {
      if (rec.forgottenAt !== undefined) continue; // 已经遗忘的就不再老化
      const target = rank(targetClarity(rec, at));
      const current = rank(rec.clarity);
      if (target < current) rec.clarity = ofRank(current - 1); // 慢慢模糊
      else if (target > current) rec.clarity = ofRank(target); // 复习回升
    }
  }
  next.lastDecayAt = (next.lastDecayAt || now) + steps * DAY_MS;
  // 只剩印象不是遗忘：还能被提起来；只有「不重要 + 已经只剩印象」才真正删掉并计数。
  const kept = [];
  for (const r of next.records) {
    // 软删除的留着等找回，但过了保留期就真删。
    if (r.forgottenAt !== undefined) {
      if (now - r.forgottenAt > FORGET_PURGE_MS) {
        next.stats.purged = (next.stats.purged || 0) + 1;
        continue;
      }
      kept.push(r);
      continue;
    }
    const forgettable = r.clarity === 'trace' && !r.pinned && !r.first && !r.owner && r.kind !== 'identity' && r.importance < 20;
    if (forgettable) {
      // 真删改成软删除：标上时间，90 天内都能从面板找回来。
      r.forgottenAt = now;
      next.stats.forgotten = (next.stats.forgotten || 0) + 1;
      kept.push(r);
      continue;
    }
    kept.push(r);
  }
  next.records = kept;
  return next;
}

export const MAX_RECORDS = 3000;
// 软删除保留多久。遗忘可以找回，但不能无限留着——90 天够你反悔，也不至于让文件只涨不跌。
export const FORGET_PURGE_MS = 90 * DAY_MS;

/** 记下这条时她的心情，回忆时当一句话带出来。中间地带不加，省字数。 */
export function feelLabel(feel) {
  if (!feel || !Number.isFinite(feel.v)) return '';
  if (feel.v >= 0.7) return '那会儿我挺高兴';
  if (feel.v >= 0.58) return '那会儿我心情还行';
  if (feel.v <= 0.3) return '那会儿我挺难受';
  if (feel.v <= 0.42) return '那会儿我有点闷';
  return '';
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** 软删除：标记而不是移除。已遗忘的不注入、不参与排序，但还能找回来。 */
export function forget(card, id, now = 0) {
  const next = structuredClone(card);
  const rec = next.records.find((r) => r.id === id && r.forgottenAt === undefined);
  if (!rec) return next;
  rec.forgottenAt = now;
  next.stats = next.stats || { forgotten: 0 };
  next.stats.forgotten = (next.stats.forgotten || 0) + 1;
  return next;
}

/** 找回：清掉遗忘标记，直接回到「清晰」。 */
export function restore(card, id) {
  const next = structuredClone(card);
  const rec = next.records.find((r) => r.id === id && r.forgottenAt !== undefined);
  if (!rec) return next;
  delete rec.forgottenAt;
  rec.clarity = 'vivid';
  return next;
}

/** 记住一条。去重（同文不同次），主人的话优先。 */
export function remember(card, text, { now = 0, owner = false, inGroup = false, direct = false, pinned = false, maxRecords = MAX_RECORDS, mood = null } = {}) {
  const t = String(text || '').trim();
  if (!t) return card;
  const next = structuredClone(card);
  const feel = mood && Number.isFinite(mood.v) ? { v: round2(mood.v), a: round2(mood.a) } : undefined;
  const existing = next.records.find((r) => r.text === t);
  if (existing) {
    existing.lastSeenAt = now;
    existing.recallCount = (existing.recallCount || 0) + 1;
    existing.clarity = 'vivid';
    // 再提一次时，记的是「最近一次提到时」的心情；遗忘过的顺便复活。
    if (feel) existing.feel = feel;
    if (existing.forgottenAt !== undefined) delete existing.forgottenAt;
    return next;
  }
  const { score, isFirst, emotional } = scoreMemory(t, { owner, inGroup, direct });
  const first = Boolean(isFirst && owner) || next.records.length === 0;
  const kind = classify(t);
  const rec = {
    id: `m_${createHash('sha1').update(`${t}|${now}`).digest('hex').slice(0, 8)}`,
    text: t.slice(0, 300),
    kind,
    importance: first && owner ? 100 : score,
    emotional,
    clarity: 'vivid',
    createdAt: now,
    lastSeenAt: now,
    recallCount: 0,
    pinned: Boolean(pinned || (first && owner)),
    first: Boolean(first && owner),
    owner: Boolean(owner),
  };
  if (feel) rec.feel = feel;
  // 先判断覆盖，再入栈：不然新记录会和自己比，把自己的两字窗当成「同一件事」。
  const victim = findSupersedeTarget(next, t);
  next.records.push(rec);
  if (victim) {
    victim.supersededAt = now;
    next.stats.superseded = (next.stats.superseded || 0) + 1;
  }
  // 安全阀：条数有上限，先淘汰「日常闲话」，再淘汰事件，最后才动「关于他是谁」的记录；锚点永远不动。
  if (next.records.length > maxRecords) {
    const active = next.records.filter((r) => r.forgottenAt === undefined);
    const archived = next.records.filter((r) => r.forgottenAt !== undefined);
    const over = next.records.length - maxRecords;
    // 先按老规矩从「还在用的」里淘汰；不够再按遗忘时间清最老的软删除。
    const victims = active
      .filter((r) => !r.pinned && !r.first)
      .sort((a, b) => (KIND_RANK[a.kind] ?? 0) - (KIND_RANK[b.kind] ?? 0)
        || a.importance - b.importance || rank(a.clarity) - rank(b.clarity) || a.lastSeenAt - b.lastSeenAt)
      .slice(0, over);
    if (victims.length < over) {
      victims.push(...[...archived].sort((a, b) => a.forgottenAt - b.forgottenAt).slice(0, over - victims.length));
    }
    const dropSet = new Set(victims);
    next.records = next.records.filter((r) => !dropSet.has(r));
    next.stats.evicted = (next.stats.evicted || 0) + victims.length;
  }
  return next;
}

/**
 * 排序：初次相遇/置顶永远在前；「关于他是谁」紧跟其后（有上限），
 * 然后是 query 命中的，最后按清晰度和重要度补。
 * 不把身份类提前的话，store 里留着也白留——最近几句 vivid 闲聊会把 2200 字挤满。
 */
export function rankForPrompt(card, { now = 0, query = '' } = {}) {
  const live = card.records.filter((r) => r.forgottenAt === undefined); // 忘了的就是忘了：不再注入
  const anchors = live.filter((r) => r.pinned || r.first);
  const rest = live.filter((r) => !r.pinned && !r.first);
  const idents = rest.filter((r) => r.kind === 'identity').slice(0, 8);
  const others = rest.filter((r) => r.kind !== 'identity');
  const byValue = [...others].sort((a, b) => {
    const c = rank(b.clarity) - rank(a.clarity);
    if (c) return c;
    const i = b.importance - a.importance;
    return i || b.lastSeenAt - a.lastSeenAt;
  });
  const head = query ? search(others, query, { now, limit: 6 }).map((h) => h.rec) : [];
  return [...anchors, ...idents, ...head, ...byValue];
}

/** 注入块。 */
export function render(card, { now = 0, maxChars = 2200, query = '' } = {}) {
  const seen = new Set();
  const lines = [];
  let used = 0;
  for (const r of rankForPrompt(card, { now, query })) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const days = Math.max(0, Math.round((now - r.lastSeenAt) / DAY_MS));
    const when = days === 0 ? '今天' : days === 1 ? '昨天' : days < 7 ? `${days} 天前` : `${Math.floor(days / 7)} 周前`;
    // 一条记忆带两样东西：它现在有多清楚，以及记下它时我的心情。
    const bits = [];
    if (r.clarity !== 'vivid') bits.push(CLARITY_LABEL[r.clarity]);
    const feeling = feelLabel(r.feel);
    if (feeling) bits.push(feeling);
    const tag = bits.length ? `（${bits.join('，')}）` : '';
    const line = `- [${when}]${tag} ${r.text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  return `【你记得的事】\n${lines.join('\n')}\n（这些是以前的事，不是他刚说的；不确定就说记不清，别编。）`;
}

export function stats(card) {
  const by = { vivid: 0, clear: 0, fuzzy: 0, trace: 0 };
  let total = 0;
  let archived = 0;
  for (const r of card.records) {
    if (r.forgottenAt !== undefined) { archived += 1; continue; } // 软删除的不算进「她还记得的」
    total += 1;
    by[r.clarity] = (by[r.clarity] || 0) + 1;
  }
  return { total, archived, ...by, forgotten: card.stats?.forgotten || 0, purged: card.stats?.purged || 0 };
}
