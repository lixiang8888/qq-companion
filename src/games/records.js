// 她的游戏账本（game.json）：最近玩了哪一款、每款各自的进度。
//
// 2026-11-26 之前这本账是 PvZ 专用的（根上直接是 level/cleared/top/last）。
// 现在形状换成通用记录；读旧文件时迁移一次，不丢她已有的关卡和最好成绩。

import { dayKeyOf } from '../affect/core.js';

/** 「最近在玩」这句话能说多久。过期了还提，就是编。 */
export const SESSION_TTL = 48 * 3600e3;
const RECENT_KEEP = 8;

export function createRecords() {
  return { version: 2, at: 0, day: '', plays: 0, last: null, recent: [], library: {} };
}

/** 旧一局的记录（PvZ 形状）→ 通用一条。 */
export function legacyEntry(e = {}) {
  if (!e || typeof e !== 'object' || !Number(e.at)) return null;
  return {
    at: Number(e.at) || 0,
    day: String(e.day || ''),
    game: 'pvz',
    title: '植物大战僵尸',
    facts: legacyFacts(e),
    victory: Boolean(e.victory),
    quit: false,
    thought: String(e.thought || ''),
    label: String(e.label || ''),
    intensity: Number(e.intensity) || 0,
    anchor: String(e.anchor || ''),
  };
}

/** 旧 resultText 的同一套说法：只写这一局真的发生过的数。 */
export function legacyFacts(e = {}) {
  const n = Number(e.level) || 1;
  const wave = Number(e.wave) || 0;
  const maxWaves = Number(e.maxWaves) || 0;
  if (!wave) return '';
  const bits = [`第 ${n} 关（${maxWaves || 20} 波）`, `打到第 ${wave}/${maxWaves || 20} 波`];
  bits.push(e.victory ? '把僵尸全挡回去了' : '没挡住');
  if (Number(e.score)) bits.push(`分数 ${Number(e.score)}`);
  if (Number(e.defeated)) bits.push(`打掉 ${Number(e.defeated)} 个僵尸`);
  if (Number(e.minutes)) bits.push(`玩了 ${Math.max(1, Math.round(Number(e.minutes)))} 分钟`);
  return bits.join('，');
}

/** 读进来的账本，无论新旧都变成当前形状。 */
export function migrateRecords(state = {}) {
  if (!state || typeof state !== 'object') return createRecords();
  if (Number(state.version) === 2) {
    return {
      ...createRecords(),
      ...state,
      last: state.last && typeof state.last === 'object' ? state.last : null,
      recent: Array.isArray(state.recent) ? state.recent.slice(0, RECENT_KEEP) : [],
      library: state.library && typeof state.library === 'object' ? { ...state.library } : {},
    };
  }
  const pvz = {};
  for (const k of ['level', 'cleared', 'top', 'plays', 'at', 'day']) {
    if (state[k] !== undefined) pvz[k] = state[k];
  }
  const last = legacyEntry(state.last);
  const recent = Array.isArray(state.recent) ? state.recent.map(legacyEntry).filter(Boolean).slice(0, RECENT_KEEP) : [];
  return {
    ...createRecords(),
    at: Number(state.at) || 0,
    day: String(state.day || ''),
    plays: Number(state.plays) || 0,
    last,
    recent,
    library: Object.keys(pvz).length ? { pvz } : {},
  };
}

/**
 * 记一局。progress 是这一款游戏自己的存档（PvZ 的关卡/最好成绩之类），整体替换。
 */
export function noteSession(state = {}, {
  game = '', title = '', at = 0, day = '', facts = '',
  victory = false, quit = false, thought = '', label = '', intensity = 0, anchor = '', progress = null,
} = {}) {
  const base = migrateRecords(state);
  const entry = {
    at: Number(at) || 0,
    day: String(day || dayKeyOf(Number(at) || 0)),
    game: String(game || ''),
    title: String(title || game || ''),
    facts: String(facts || ''),
    victory: Boolean(victory),
    quit: Boolean(quit),
    thought: String(thought || ''),
    label: String(label || ''),
    intensity: Number(intensity) || 0,
    anchor: String(anchor || ''),
  };
  const library = progress && entry.game
    ? { ...base.library, [entry.game]: { ...progress, title: entry.title, at: entry.at, day: entry.day } }
    : { ...base.library };
  return {
    ...base,
    at: entry.at,
    day: entry.day,
    plays: (Number(base.plays) || 0) + 1,
    last: entry,
    recent: [entry, ...(base.recent || [])].slice(0, RECENT_KEEP),
    library,
  };
}

/** 她最近在玩的那一行（上下文注入用）。没有/过期就空。 */
export function gameLine(state = {}, now = 0, { ttl = SESSION_TTL } = {}) {
  const last = state?.last;
  const at = Number(last?.at) || 0;
  if (!at || !last?.game) return { text: '', at: 0, ttl };
  if (now - at > ttl) return { text: '', at, ttl };
  const title = last.title || last.game;
  let text = `你最近在玩《${title}》：上一局${last.facts || ''}`;
  if (last.thought) text += `（你的原话：${last.thought}）`;
  return { text: `${text}。`, at, ttl };
}

/** 面板用：玩过几款、分别什么进度。只报真数。 */
export function libraryLines(state = {}) {
  const lib = state?.library || {};
  return Object.entries(lib).map(([id, v]) => {
    const bits = [];
    if (Array.isArray(v?.cleared) && v.cleared.length) bits.push(`过了第 ${v.cleared.join('、')} 关`);
    if (Number(v?.best)) bits.push(`最高 ${Number(v.best)}`);
    if (Number(v?.level) && !Array.isArray(v?.cleared)) bits.push(`第 ${Number(v.level)} 关`);
    if (Number(v?.wins)) bits.push(`赢过 ${Number(v.wins)} 次`);
    return { id, title: String(v?.title || id), text: bits.join(' · ') };
  });
}
