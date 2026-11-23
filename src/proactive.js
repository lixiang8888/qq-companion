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
//
// 2026-11-23 改：她「说了话在等回」不再是一个自己维护的计数器，而是**从历史现算的事实**
// （openThread / waitingState）。以前 consecutive、expect、leftOnRead 各存一份影子状态，
// 和真事实不同源：被晾用「他最后一句」算等待（他八小时没说话就永远不算），连发到 2 条
// 就永久沉默（他几天不理她，她也就一直安静），现在全删了。

import { sanitizeSecrets } from './memory/sanitize.js';
import { dayKeyOf } from './affect/core.js';

const MIN = 60e3;
const HOUR = 36e5;
const DAY = 864e5;

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
  // ---- 在场：聊天还在进行中的那十几分钟。中途的沉默按分钟算，不是按小时。----
  presenceWindowMinutes: 30, // 必须 ≥ activeMaxWaitMinutes，否则「还在场」永远追不上「期待点」
  activeMinWaitMinutes: 5,
  activeMaxWaitMinutes: 20,
  activePokeMax: 1,         // 一段对话里最多插一句（连发到这条就不再插）
  activePerDay: 2,
  activePerHour: 1,
  // ---- 被晾：她说了话、没人接。真实事件，不是编的。----
  leftOnReadMinutes: 20,    // 沉默超过这么久才算「人没了」
  leftOnReadIntensity: 0.2, // 轻到只改语气
  leftOnReadMaxPerDay: 2,   // 一天最多为几句没回委屈（每句最多一次）
  // ---- 她放下：太久没回，她就不等了（也不再提）。人问一句没回音，隔天就算了。----
  expireMinutes: 720,       // 12 小时：超过这个点，那句就当收掉了
  hungNoticeMinutes: 120,   // 他隔了这么久才回来，才算「晾了她一会儿」，值得让她知道
  // ---- 破例：连发到上限之后，他几天不理她，她也不该永远死寂 ----
  breakAfterDays: 3,        // 隔这么多天允许再问一句
  // ---- 深夜：情绪占主导——安静时段的例外由情绪决定，不由时钟 ----
  nightExceptionIntensity: 0.6,
  nightExceptionMaxPerNight: 1,
  nightAwakeMinutes: 30,    // 他 N 分钟内还说过话 = 还没睡，可以搭一句
};

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

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
 * 她说了话、没人接——这是历史里的事实，不是一个计数器。
 *
 * 尾巴上、最后一条 user 之后的 assistant 消息，就是「她还在等」的那几句：
 * 数量 = 连发了几条，最后一条的时间 = 她从什么时候开始在等。
 *
 * 前提：session 压缩时一定保住最后 keepRecent（16）条原话，所以她最新那句永远在历史里。
 * 压缩摘要不进历史（是另一段），所以这里不会被摘要污染。
 * @returns {{unanswered:number, lastAt:number, lastText:string}}
 */
export function openThread(history = []) {
  const h = Array.isArray(history) ? history : [];
  const i = h.map((m) => m?.role).lastIndexOf('user');
  const tail = h.slice(i + 1).filter((m) => m && m.role === 'assistant' && Number(m.at) > 0);
  const last = tail[tail.length - 1];
  return {
    unanswered: tail.length,
    lastAt: Number(last?.at) || 0,
    lastText: String(last?.text || ''),
  };
}

/**
 * 她现在等到哪一档了。全是现算：等多久、几句没回。
 *   none      没人等她（最后一条是他说的，或者没聊过）
 *   waiting   刚说完，还在正常范围（< 20 分钟）
 *   ignored   20 分钟到 12 小时：他这一会儿没接（可以给一点「被晾」）
 *   dropped   超过 12 小时：她自己把这句话收掉了，不再等，也不再提
 */
export function waitingState({ now = 0, history = [], cfg = DEFAULTS } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const o = openThread(history);
  if (!o.unanswered || !o.lastAt) return { ...o, waitedMs: 0, stage: 'none' };
  const waitedMs = Math.max(0, now - o.lastAt);
  const stage = waitedMs < c.leftOnReadMinutes * MIN
    ? 'waiting'
    : waitedMs <= c.expireMinutes * MIN ? 'ignored' : 'dropped';
  return { ...o, waitedMs, stage };
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
 * 对话还在不在进行中：他最后一句就在这几分钟里，而且最后一条是她回的（她在等他接）。
 * 这一条不读盘、不猜：只看时间戳和最后一条是谁。
 */
export function isPresent({ now, lastUserAt = 0, history = [], cfg = DEFAULTS } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const at = num(lastUserAt, 0);
  if (!at || now - at > c.presenceWindowMinutes * MIN) return false;
  const last = [...(history || [])].pop();
  return Boolean(last && last.role === 'assistant');
}

/**
 * 期待点：这一轮说完之后，她大概什么时候会想他。
 * 四样真事：他平时多久回、这轮几点结束、已经连发了几条没回、**聊天还在不在进行中**。
 * 在场时按「刚刚的节奏」算（几分钟），不在场才退回「他平时多久回」（小时）。
 */
export function expectAt({ now, lastUserAt = 0, lastBotAt = 0, history = [], cfg = DEFAULTS, consecutive = 0, present = false } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const gap = typicalGap(history) || (present ? c.activeMaxWaitMinutes * MIN : c.minIdleMinutes * MIN);
  const factor = Math.pow(Math.max(1, c.backoffFactor), clamp(num(consecutive, 0), 0, 5));
  const from = Math.max(num(lastUserAt, 0), num(lastBotAt, 0)) || now;
  const raw = from + (present
    ? clamp(gap * 1.5, c.activeMinWaitMinutes * MIN, c.activeMaxWaitMinutes * MIN)
    : clamp(gap * factor, c.minIdleMinutes * MIN, c.maxWaitMinutes * MIN));
  const at = outOfQuiet(raw, c);
  const why = [];
  if (present) why.push('他还在等你接话，按刚刚的节奏算');
  else why.push(num(consecutive, 0) > 0 ? `已经连发 ${consecutive} 条没回，往后多等一会儿` : '按他平时回话的快慢算');
  if (at !== raw) why.push('落在安静时段，挪到早上');
  return { at: Math.max(at, now), why: why.join('；') };
}

/** 期待点 + 她自己定过的「晚点再想」（那是决定，不是影子：她真说过这句话）。 */
function expectFor({ now, cfg, history, lastUserAt = 0, state = {}, open, pokes = 0, present = false }) {
  const e = expectAt({
    now,
    lastUserAt,
    lastBotAt: open.lastAt,
    history,
    cfg,
    consecutive: pokes,
    present,
  });
  const waitUntil = num(state.waitUntil, 0);
  // 「晚点再想」是她亲口定的：到了那个点她才重新想，不能因为期待点已经过去就每十分钟问一遍。
  if (waitUntil > e.at) {
    return { at: waitUntil, why: String(state.waitWhy || '上次想过了，说晚点再想') };
  }
  return e;
}

/** 他说话了：她定过的「晚点再想」作废——他有动静，这一轮不用她惦记。 */
export function noteSaidByUser(state = {}) {
  return { ...state, waitUntil: 0, waitWhy: '' };
}

/**
 * 真发出去了：记一条，期待点作废（下一轮从历史现算）。
 * `active` = 这次是在场时插的一句，单独计数（每天/每小时都有上限，不受 minGap 约束）。
 * `night` = 这次是深夜例外（情绪重或他还没睡），一夜只给一次。
 * `breaking` = 这次是「好几天没回」的破例，记下来，免得一天破例三次。
 */
export function notePoked({ state = {}, now, active = false, night = false, breaking = false } = {}) {
  const day = dayKeyOf(now);
  const same = state.day === day;
  const activeN = state.active?.day === day ? num(state.active.n, 0) : 0;
  const nightN = state.night?.day === day ? num(state.night.n, 0) : 0;
  return {
    ...state,
    day,
    count: (same ? num(state.count, 0) : 0) + 1,
    lastPokeAt: now,
    waitUntil: 0,
    waitWhy: '',
    ...(breaking ? { breakAt: now } : {}),
    ...(active ? { active: { day, n: activeN + 1, lastAt: now } } : {}),
    ...(night ? { night: { day, n: nightN + 1, at: now } } : {}),
  };
}

/**
 * 想过了但没发（或者想的时候出错）：她亲口说「晚点再想」——这是一次决定，得记。
 * 同时记一次「想」，避免每十分钟重问一遍模型。
 */
export function noteWait({ state = {}, now, minutes, cfg = DEFAULTS, present = false } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const day = dayKeyOf(now);
  // 在场时「晚点再想」也只在几分钟量级：按 45 分钟推，等于这一轮对话就此结束了。
  const cap = present ? Math.max(10, c.activeMaxWaitMinutes) : 240;
  const mins = clamp(num(minutes, c.defaultWaitMinutes), 10, cap);
  const thinks = state.thinks?.day === day ? num(state.thinks.n, 0) : 0;
  return {
    ...state,
    thinks: { day, n: thinks + 1 },
    waitUntil: outOfQuiet(now + mins * MIN, c),
    waitWhy: `上次想过了，说晚点再想（${mins} 分钟）`,
  };
}

/**
 * 他现在该不该被她想起。
 *
 * 两条通道：
 *   · 在场（聊天进行中）：按分钟算，一段对话里最多插一句（activePokeMax），豁免 minGap——
 *     不然「至少隔 2 小时」会把所有追问都挡掉，等于没这个功能。
 *   · 不在场：连发上限给「还能不能再说」；他几天不理她，允许破例问一句（不是永久死寂）。
 *   · 深夜：情绪占主导。安静时段不是铁律，情绪重（≥ nightExceptionIntensity）或者他还没睡
 *     （nightAwakeMinutes 内说过话）就给一次，一夜只给一次。
 *
 * 所有判据都从 `history` 现算：最后一条是谁、几句没回、从什么时候开始等。
 * @param {boolean} [o.present] 显式指定在场（默认按 isPresent 现算）
 * @param {{label?:string,intensity?:number}} [o.emotion] 此刻的情绪，用来判深夜例外
 */
export function pokeGate({ now, cfg = DEFAULTS, history = [], lastUserAt = 0, state = {}, mood = 0.5, present, emotion = null } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const no = (reason) => ({ ok: false, reason });
  const s = state || {};
  const hist = Array.isArray(history) ? history : [];
  const lastUser = num(lastUserAt, 0) || [...hist].reverse().find((m) => m?.role === 'user')?.at || 0;
  const here = present === undefined ? isPresent({ now, lastUserAt: lastUser, history: hist, cfg: c }) : Boolean(present);
  const open = openThread(hist);
  const day = dayKeyOf(now);
  const quiet = inQuietHours(new Date(now).getHours(), c);

  if (!c.enabled) return no('未开启');
  if (!lastUser) return no('还没有聊过');
  if (mood < c.moodFloor) return no('心情太低，不想主动');
  if (s.day === day && num(s.count, 0) >= c.maxPerDay) return no('今天已经找过了');
  const thinks = s.thinks?.day === day ? num(s.thinks.n, 0) : 0;
  if (thinks >= c.maxThinksPerDay) return no('今天想得够多了');
  // 深夜例外：不是「安静时段放行」，是这一刻情绪占主导（或者他还没睡）。
  // 放行的是**整条**排期：期待点会被安静时段推到早上，只放行时段、不放行期待点，例外就等于不存在。
  let nightOk = false;
  if (quiet) {
    // 时间戳可能比 now 还晚（换天、补数据）：那不算「他刚说过话」，算没数据。
    const sinceUser = now - num(lastUser, 0);
    const awake = sinceUser >= 0 && sinceUser <= c.nightAwakeMinutes * MIN;
    const moved = num(emotion?.intensity, 0) >= c.nightExceptionIntensity;
    const used = s.night?.day === day ? num(s.night.n, 0) : 0;
    if (!(awake || moved) || used >= c.nightExceptionMaxPerNight) {
      return no(`安静时段（${c.quietFrom}:00–${c.quietTo}:00）`);
    }
    nightOk = true;
  }
  // 她最后那条「等他回」的 assistant 消息里，第一条是她这轮的正常回复，之后每多一条才是她又追问了一次。
  const pokes = Math.max(0, open.unanswered - 1);
  const expect = expectFor({ now, cfg: c, history: hist, lastUserAt: lastUser, state: s, open, pokes, present: here });

  // 在场：只判「这一刻能不能插一句」，其余护栏照旧。
  if (here) {
    const activeDay = s.active?.day === day ? num(s.active.n, 0) : 0;
    if (activeDay >= c.activePerDay) return no('今天聊到一半时已经插过话了');
    const lastActive = num(s.active?.lastAt, 0);
    if (lastActive && now - lastActive < (60 / Math.max(1, c.activePerHour)) * MIN) return no('刚才已经问过他一次了');
    // 她回完那句之后，尾巴上多出来的 assistant 消息就是她插的话。
    if (open.unanswered - 1 >= c.activePokeMax) return no('已经在等他接了');
    if (!nightOk && expect.at && now < expect.at) return no(`还没到期待的时间（${hhmm(expect.at)}）`);
    return {
      ok: true,
      active: true,
      night: quiet,
      idleMinutes: Math.max(0, Math.round((now - lastUser) / MIN)),
      expectAt: num(expect.at, 0),
      why: String(expect.why || ''),
      open,
    };
  }

  if (s.lastPokeAt && now - s.lastPokeAt < c.minGapMinutes * MIN) return no('刚说过话，先缓缓');

  // 连发到上限：不再一条接一条；但他几天不理她，她也不该永远安静——允许破例再问一句。
  let breaking = false;
  if (pokes >= c.maxConsecutive) {
    const lastAt = num(open.lastAt, 0);
    const lastBreak = num(s.breakAt, 0);
    const canBreak = lastAt > 0
      && now - lastAt >= c.breakAfterDays * DAY
      && (!lastBreak || now - lastBreak >= c.breakAfterDays * DAY);
    if (!canBreak) return no(`连发 ${pokes} 条都没回，等他说`);
    breaking = true;
  }
  if (!breaking && !nightOk) {
    if (expect.at && now < expect.at) return no(`还没到期待的时间（${hhmm(expect.at)}）`);
    if (!expect.at && now - lastUser < c.minIdleMinutes * MIN) return no('还没那么久');
  }
  return {
    ok: true,
    active: false,
    break: breaking,
    night: quiet,
    idleHours: Math.round((now - lastUser) / HOUR),
    idleMinutes: Math.max(0, Math.round((now - lastUser) / MIN)),
    expectAt: breaking ? 0 : num(expect.at, 0),
    why: breaking
      ? `连着 ${Math.max(1, Math.floor((now - num(open.lastAt, 0)) / DAY))} 天没回，她决定再问一句`
      : String(expect.why || ''),
    open,
  };
}

/** 给她的「自己想想」提示。不是用户消息，她看完不该当成他说过这句。 */
export function composePokePrompt({ clock = '', idle = '', lastLine = '', hint = '', inner = '', doing = '', events = [], feel = '', waiting = '' } = {}) {
  const lines = [`【这是你自己在想，不是他说的】现在 ${clock}，${idle}。`];
  if (doing) lines.push(`你此刻：${sanitizeSecrets(doing).slice(0, 60)}。`);
  // 她说过一句还没人接：那是真事，写给她看，免得隔了几个小时又从头问一遍。
  if (waiting) lines.push(`你刚才说的一句「${sanitizeSecrets(waiting).slice(0, 60)}」他还没回。`);
  // 情绪占主导：开不开口、说得急不急，得带着此刻的心情，不是只看时钟。
  if (feel) lines.push(`你现在的状态：${sanitizeSecrets(feel).slice(0, 40)}。话会跟着这个状态变，但别说出来。`);
  if (lastLine) lines.push(`你们最后说的一句是：「${sanitizeSecrets(lastLine).slice(0, 120)}」。`);
  // 这些是外面真的变了的几件事（屏幕、天气、时间、记忆、钱），不是抽出来的剧情。
  // 有就写在明处：她的念头得有个来处，否则就只会说「我想你了」。
  if (events?.length) {
    lines.push('【外面真的发生了什么】');
    for (const e of events.slice(0, 6)) lines.push(`- ${sanitizeSecrets(String(e?.text ?? '')).slice(0, 80)}`);
  }
  if (hint) lines.push(`你心里还挂着件事：${sanitizeSecrets(hint).slice(0, 60)}。`);
  if (inner) lines.push(`上次这个点你也想过这事，当时想的是：「${sanitizeSecrets(inner).slice(0, 60)}」。`);
  lines.push('要不要找他？他可能在忙、在睡，也可能这会儿就是不想说话——不说也完全没问题。');
  lines.push('要是你心里有个具体的疑问（外面的新闻、某个东西是什么），可以顺手查一下，加一个键："search":"你想查的那句话"。');
  lines.push('顺便说一句你接下来想干什么（不用装成上班通勤），和你心里那句话。');
  lines.push('只回一个 JSON，别的什么都不要：');
  lines.push('{"send":false,"waitMinutes":45,"reason":"一句话，为什么先不说","doing":"接下来想干什么，不想就留空","think":"心里那句话，二十字以内，可以留空"}');
  lines.push('或者 {"send":true,"message":"你要发过去的那句话","doing":"","think":""}');
  lines.push('想查就再加一句：{"send":false,"waitMinutes":60,"reason":"…","doing":"","think":"","search":"湖州明天会下雨吗"}');
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
 *
 * `doing`：她接下来想干什么，喂给「她此刻」那块（长度封死，进系统提示）。
 * `think`：她心里那句话，只在她下一次自己想起来时被读回，不进对话、不进记忆。
 */
export function parsePokeReply(text) {
  const raw = String(text || '').trim();
  const j = pickJson(raw);
  const doing = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const think = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (j && typeof j === 'object') {
    const waitMinutes = num(j.waitMinutes, DEFAULTS.defaultWaitMinutes);
    // 查什么跟发不发是两件事：可以只想查、不说话。
    const search = String(j.search || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const extra = { doing: doing(j.doing), think: think(j.think) };
    if (j.send === true) {
      const message = String(j.message || '').trim();
      if (message && !isSilent(message)) return { send: true, message, search, ...extra };
      return { send: false, waitMinutes, search, reason: String(j.reason || '想说，但没话'), ...extra };
    }
    return { send: false, waitMinutes, search, reason: String(j.reason || ''), ...extra };
  }
  if (!raw || isSilent(raw)) return { send: false, waitMinutes: DEFAULTS.defaultWaitMinutes, search: '', reason: '没想好说什么', doing: '', think: '' };
  // 整段当一句话的兜底路径里没有结构化字段：她在想什么就是这句，但 doing 不猜。
  return { send: true, message: raw, search: '', doing: '', think: '' };
}

/**
 * 记一次「她想过了」。跟 noteWait 分开：这一笔记的是**真的调了模型**，
 * 面板上「今天想了 N 次、其中 M 次是因为外面真有事」就是它。
 */
export function noteTick(state = {}, { now, events = 0 } = {}) {
  const day = dayKeyOf(now);
  const same = state.ticks?.day === day;
  return {
    ...state,
    ticks: { day, n: (same ? num(state.ticks.n, 0) : 0) + 1 },
    lastEvents: Math.max(0, Math.round(num(events))),
  };
}
