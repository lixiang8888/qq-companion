// 主动搭话：不是闹钟，是聊完之后心里那点惦记。
//
// 触发点跟着对话走，不跟时钟走：她说完一轮，按「他平时多久会回」算一个期待时间；
// 到点他还没吭声，她才自己想一次要不要找他。想的结果是一小段 JSON——发，或者晚点再想。
//
// 为什么不用固定间隔：固定间隔会让「找他」变成播报。期待点是从这轮对话里长出来的，
// 所以它总有来处；没有来处的话，她本来就该沉默。
//
// 护栏顺序：开关 → 安静时段/心情/每日上限/冷却 → 连发上限 → 期待时间。
// 判「不说」时一个字都不发，也不写进任何她记得的地方。

import { sanitizeSecrets } from './memory/sanitize.js';
import { dayKeyOf } from './affect/core.js';

const MIN = 60e3;
const HOUR = 36e5;

export const DEFAULTS = {
  enabled: false,
  minIdleMinutes: 180,      // 他多久不吭声，才轮到她惦记
  maxWaitMinutes: 720,      // 期待点最远推到多久
  maxPerDay: 3,             // 一天最多真发几条
  minGapMinutes: 120,       // 两条之间至少隔多久
  quietFrom: 23,
  quietTo: 8,
  moodFloor: 0.25,
  maxConsecutive: 2,        // 他还没回，最多连发几条
  backoffFactor: 2,         // 连发没回，期待点一次比一次晚
  maxThinksPerDay: 12,      // 一天最多「想」几次（想而不发也花钱）
  defaultWaitMinutes: 45,
};

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function inQuietHours(hour, { quietFrom, quietTo }) {
  if (quietFrom === quietTo) return false;
  return quietFrom < quietTo ? hour >= quietFrom && hour < quietTo : hour >= quietFrom || hour < quietTo;
}

/** 落在安静时段就推到起床那一刻；醒着就原样返回。 */
export function outOfQuiet(t, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  if (!inQuietHours(new Date(t).getHours(), c)) return t;
  const next = new Date(t);
  next.setHours(c.quietTo, 0, 0, 0);
  if (next.getTime() <= t) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/**
 * 他平时多久会回一句：相邻两条消息间隔的中位数，夹在 10 分钟到 6 小时之间。
 * 没有历史就不猜（返回 0，由调用方退回 minIdleMinutes）。
 */
export function typicalGap(history = []) {
  const at = [...(history || [])].map((m) => Number(m?.at)).filter((n) => Number.isFinite(n) && n > 0);
  const gaps = [];
  for (let i = 1; i < at.length; i += 1) {
    const d = at[i] - at[i - 1];
    // 十秒内的是同一轮的往返，不算「回复间隔」。
    if (d > MIN && d < 7 * 24 * HOUR) gaps.push(d);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return clamp(gaps[Math.floor(gaps.length / 2)], 10 * MIN, 6 * HOUR);
}

/**
 * 期待点：这一轮说完之后，她大概什么时候会想他。
 * 三样真事：他平时多久回、这轮几点结束、已经连发了几条没回。
 */
export function expectAt({ now, lastUserAt = 0, lastBotAt = 0, history = [], cfg = DEFAULTS, consecutive = 0 } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const gap = typicalGap(history) || c.minIdleMinutes * MIN;
  const factor = Math.pow(Math.max(1, c.backoffFactor), clamp(num(consecutive, 0), 0, 5));
  const from = Math.max(num(lastUserAt, 0), num(lastBotAt, 0)) || now;
  const raw = from + clamp(gap * factor, c.minIdleMinutes * MIN, c.maxWaitMinutes * MIN);
  const at = outOfQuiet(raw, c);
  const why = [];
  why.push(num(consecutive, 0) > 0 ? `已经连发 ${consecutive} 条没回，往后多等一会儿` : '按他平时回话的快慢算');
  if (at !== raw) why.push('落在安静时段，挪到早上');
  return { at: Math.max(at, now), why: why.join('；') };
}

/** 她说完一轮：重算期待点。 */
export function noteTurn({ now, state = {}, lastUserAt = 0, history = [], cfg = DEFAULTS, consecutive } = {}) {
  const e = expectAt({
    now,
    lastUserAt,
    lastBotAt: now,
    history,
    cfg,
    consecutive: consecutive ?? num(state.consecutive, 0),
  });
  return { ...state, expect: { at: e.at, why: e.why, from: now } };
}

/** 他说话了：连发改零，期待点作废——他有动静，这一轮不用她惦记。 */
export function noteSaidByUser(state = {}) {
  return { ...state, consecutive: 0, expect: {} };
}

/** 真发出去了：记一条，连发 +1，期待点清空等下一轮重算。 */
export function notePoked({ state = {}, now } = {}) {
  const day = dayKeyOf(now);
  const same = state.day === day;
  return {
    ...state,
    day,
    count: (same ? num(state.count, 0) : 0) + 1,
    lastPokeAt: now,
    consecutive: num(state.consecutive, 0) + 1,
    expect: {},
  };
}

/**
 * 想过了但没发（或者想的时候出错）：期待点往后推，连发不变——她没说话，不算连发。
 * 同时记一次「想」，避免每十分钟重问一遍模型。
 */
export function noteWait({ state = {}, now, minutes, cfg = DEFAULTS } = {}) {
  const day = dayKeyOf(now);
  const mins = clamp(num(minutes, DEFAULTS.defaultWaitMinutes), 10, 240);
  const thinks = state.thinks?.day === day ? num(state.thinks.n, 0) : 0;
  return {
    ...state,
    thinks: { day, n: thinks + 1 },
    // 安静时段要用他配置的那份，不是默认那份——否则期待时间会落在安静时段里。
    expect: { at: outOfQuiet(now + mins * MIN, cfg), why: `上次想过了，说晚点再想（${mins} 分钟）` },
  };
}

/** 他现在该不该被她想起。 */
export function pokeGate({ now, cfg = DEFAULTS, lastUserAt = 0, state = {}, mood = 0.5 } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const no = (reason) => ({ ok: false, reason });
  const s = state || {};

  if (!c.enabled) return no('未开启');
  if (!lastUserAt) return no('还没有聊过');
  if (inQuietHours(new Date(now).getHours(), c)) return no(`安静时段（${c.quietFrom}:00–${c.quietTo}:00）`);
  if (mood < c.moodFloor) return no('心情太低，不想主动');
  if (s.day === dayKeyOf(now) && num(s.count, 0) >= c.maxPerDay) return no('今天已经找过了');
  if (s.lastPokeAt && now - s.lastPokeAt < c.minGapMinutes * MIN) return no('刚说过话，先缓缓');
  // shortcut: 连发两条没回就必须等他说，他要是几天不理她，她就一直安静。
  // 要改这个行为，得在 maxConsecutive 之外加一条「超过 N 天可以破例一次」。
  const consec = num(s.consecutive, 0);
  if (consec >= c.maxConsecutive) return no(`连发 ${consec} 条都没回，等他说`);
  const thinks = s.thinks?.day === dayKeyOf(now) ? num(s.thinks.n, 0) : 0;
  if (thinks >= c.maxThinksPerDay) return no('今天想得够多了');

  const expect = s.expect || {};
  if (expect.at && now < expect.at) return no(`还没到期待的时间（${hhmm(expect.at)}）`);
  if (!expect.at && now - lastUserAt < c.minIdleMinutes * MIN) return no('还没那么久');

  return {
    ok: true,
    idleHours: Math.round((now - lastUserAt) / HOUR),
    expectAt: num(expect.at, 0),
    why: String(expect.why || ''),
  };
}

/** 给她的「自己想想」提示。不是用户消息，她看完不该当成他说过这句。 */
export function composePokePrompt({ clock = '', idle = '', lastLine = '', hint = '', inner = '', doing = '' } = {}) {
  const lines = [`【这是你自己在想，不是他说的】现在 ${clock}，${idle}。`];
  if (doing) lines.push(`你此刻：${sanitizeSecrets(doing).slice(0, 60)}。`);
  if (lastLine) lines.push(`你们最后说的一句是：「${sanitizeSecrets(lastLine).slice(0, 120)}」。`);
  if (hint) lines.push(`你心里还挂着件事：${sanitizeSecrets(hint).slice(0, 60)}。`);
  if (inner) lines.push(`上次这个点你也想过这事，当时想的是：「${sanitizeSecrets(inner).slice(0, 60)}」。`);
  lines.push('要不要找他？他可能在忙、在睡，也可能这会儿就是不想说话——不说也完全没问题。');
  lines.push('要是你心里有个具体的疑问（外面的新闻、某个东西是什么），可以顺手查一下，加一个键："search":"你想查的那句话"。');
  lines.push('只回一个 JSON，别的什么都不要：');
  lines.push('{"send":false,"waitMinutes":45,"reason":"一句话，为什么先不说"}');
  lines.push('或者 {"send":true,"message":"你要发过去的那句话"}');
  lines.push('想查就再加一句：{"send":false,"waitMinutes":60,"reason":"…","search":"湖州明天会下雨吗"}');
  return lines.join('\n');
}

/** 模型选择沉默时返回 true。 */
export function isSilent(reply) {
  return !String(reply || '').replace(/[\[【（(]\s*沉默\s*[\]】）)]/g, '').trim();
}

const pickJson = (text) => {
  const s = String(text || '').replace(/```[a-z]*\n?/gi, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
};

/**
 * 解读她的决定。JSON 是正路；格式坏了就整段当一句话——
 * 宁可多发一句，也不要因为少个括号整晚不说话。
 */
export function parsePokeReply(text) {
  const raw = String(text || '').trim();
  const j = pickJson(raw);
  if (j && typeof j === 'object') {
    const waitMinutes = num(j.waitMinutes, DEFAULTS.defaultWaitMinutes);
    // 查什么跟发不发是两件事：可以只想查、不说话。
    const search = String(j.search || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (j.send === true) {
      const message = String(j.message || '').trim();
      if (message && !isSilent(message)) return { send: true, message, search };
      return { send: false, waitMinutes, search, reason: String(j.reason || '想说，但没话') };
    }
    return { send: false, waitMinutes, search, reason: String(j.reason || '') };
  }
  if (!raw || isSilent(raw)) return { send: false, waitMinutes: DEFAULTS.defaultWaitMinutes, search: '', reason: '没想好说什么' };
  return { send: true, message: raw, search: '' };
}
