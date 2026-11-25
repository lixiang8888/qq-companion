// 她心里还没完成的事：想说没说的、想做没做的、答应过的、没回的那句。
//
// 为什么单独一层：日记是日结、周自述是周结、念头是十分钟一次的独白——
// 这些都不产生「欠着」的东西。他不在的时候她经历了一章书、打了一局、冒出一句想说的，
// 系统里以前只有「状态」和「记忆」，没有「这件事他还没听过」的账；没有账就没有势能，
// 所以她只会在他开口之后被动接话。
//
// 四条规矩（见 docs/superpowers/specs/2026-11-25-intent-layer-design.md）：
//   1. 没有出处（source）就不许有 loop——她说的每件事都要能在事实层核对；
//   2. 产生要多、开口要少——产生并进已有调用，开口走现有主动通道和额度；
//   3. 她可以什么都不做——「没有」是合法结果，系统不催不补；
//   4. 说过的事不能再说——销账是硬约束。
//
// 纯函数 + 注入时钟：不读盘、不调模型、不掷骰子。状态由 host 落 intents.json。

import { dayKeyOf } from './affect/core.js';
import { inQuietHours, openThread } from './proactive.js';

export const INTENT_KINDS = ['tell', 'do', 'promise', 'ask', 'reply'];
export const INTENT_MAX = 50;
export const TEXT_MAX = 60;
export const MAX_SHOWN = 2;

export const TELL_TTL_MS = 48 * 3600e3;     // 隔一天说还算新鲜，再久就是翻旧账
export const ASK_TTL_MS = 48 * 3600e3;
export const DO_TTL_MS = 36 * 3600e3;
export const REPLY_TTL_MS = 6 * 3600e3;     // 「晚点回」最多挂这么久
export const PROMISE_GRACE_MS = 24 * 3600e3; // 约定时刻之后还留一天，才判没做到
export const SHARE_AFTER_USER_MS = 10 * 60e3;
export const SHARE_IDLE_MS = 60 * 60e3;     // 他至少安静这么久，才轮到她拿自己的事开口

export const INTENT_DEFAULTS = {
  enabled: true,
  tellTtlHours: 48,
  askTtlHours: 48,
  maxLoops: 50,
  sharePerDay: 2,          // 「有话说」的主动消息，一天最多几条（也受 proactive.maxPerDay 总闸）
  shareMinGapMinutes: 60,  // 两条之间至少隔多久
  shareIdleMinutes: 60,    // 他安静这么久她才可以拿自己的事开口
  dailyPlan: false,        // 每天一次「今天想干点什么」的模型调用（默认关：多一次调用）
};

export const createIntents = () => ({ at: 0, loops: [] });

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const clock = (ms) => {
  const d = new Date(Number(ms) || 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const whenOf = (ms, now) => {
  const d = new Date(Number(ms) || 0);
  const n = new Date(Number(now) || 0);
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return same ? `今天 ${clock(ms)}` : `${d.getMonth() + 1}月${d.getDate()}日 ${clock(ms)}`;
};
/** 稳定短 id：取整个 32 位哈希的 base36（不能截前缀——相邻哈希的高位是一样的，会撞）。 */
function shortHash(s) {
  let h = 5381;
  for (const ch of String(s)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

/** 这条 loop 能不能进账：必须有出处、有正文、kind 合法。 */
export function loopIsValid(loop) {
  return Boolean(loop && INTENT_KINDS.includes(loop.kind) && String(loop.text || '').trim() && String(loop.source || '').trim());
}

/**
 * 造一条 loop（不写状态）。kind 决定寿命，promise 的到期由调用方给。
 * @returns {object|null} 不合法返回 null——宁可不记，也不记一条没法核对的账
 */
export function makeLoop({
  kind = 'tell', about = 'self', text = '', source = '', anchor = '', label = '',
  weight = 0.5, now = 0, dueAt = null, expiresAt = null, target = null,
} = {}) {
  const t = clip(text, TEXT_MAX);
  const src = clip(source, 80);
  if (!t || !src || !INTENT_KINDS.includes(kind)) return null;
  const ttl = kind === 'ask' ? ASK_TTL_MS
    : kind === 'do' ? DO_TTL_MS
      : kind === 'reply' ? REPLY_TTL_MS
        : kind === 'promise' ? PROMISE_GRACE_MS
          : TELL_TTL_MS;
  // null 会被 Number() 变成 0（「1970 年就到期」）——必须显式区分「没给」。
  const given = (v) => v !== null && v !== undefined && v !== '';
  const due = given(dueAt) ? Number(dueAt) : Number(now) || 0;
  const exp = given(expiresAt) ? Number(expiresAt) : due + ttl;
  return {
    id: `lt_${shortHash(`${kind}|${src}`)}_${Math.max(0, Math.round(Number(now) || 0)).toString(36)}`,
    kind, about: clip(about, 12) || 'self', text: t, source: src,
    anchor: clip(anchor, 40), label: clip(label, 20),
    weight: Math.max(0, Math.min(1, Number(weight) || 0.5)),
    createdAt: Number(now) || 0,
    dueAt: due,
    expiresAt: exp,
    target: target && typeof target === 'object' ? { ...target } : null,
    spokenAt: 0, doneAt: 0, droppedAt: 0, missedAt: 0, expiredAt: 0,
    attempts: 0, lastTryAt: 0,
  };
}

const closedOf = (l) => Boolean(l.spokenAt || l.doneAt || l.droppedAt || l.missedAt || l.expiredAt);

/** 还开着（没过期、没销账）。 */
export function isOpen(loop, now = 0) {
  if (!loop || closedOf(loop)) return false;
  if (Number(loop.expiresAt) > 0 && Number(now) >= Number(loop.expiresAt)) return false;
  return true;
}

export function openLoops(state = {}, now = 0) {
  return (state?.loops || []).filter((l) => isOpen(l, now));
}

/** 可以开口的：开着，而且到了能说的时候。 */
export function dueLoops(state = {}, now = 0) {
  return openLoops(state, now).filter((l) => Number(l.dueAt) <= Number(now));
}

/**
 * 记一条。同一 kind + 同一出处还没销账 → 合并（刷新正文/权重，不重复占位）。
 * 落盘只留最近 max 条；关掉的旧账留一点给面板和审计。
 */
export function addLoop(state = {}, loop, { max = INTENT_MAX } = {}) {
  if (!loopIsValid(loop)) return state || createIntents();
  const loops = [...(state?.loops || [])];
  // 同一 kind + 同一出处还没销账 → 合并（刷新正文/权重，不再占一条）
  const i = loops.findIndex((l) => isOpen(l, loop.createdAt) && l.kind === loop.kind && l.source === loop.source);
  if (i >= 0) {
    const old = loops[i];
    loops[i] = {
      ...old,
      text: loop.text || old.text,
      anchor: loop.anchor || old.anchor,
      label: loop.label || old.label,
      weight: Math.max(Number(old.weight) || 0, loop.weight),
      expiresAt: Math.max(Number(old.expiresAt) || 0, loop.expiresAt),
      dueAt: Math.min(Number(old.dueAt) || loop.dueAt, loop.dueAt),
      target: loop.target || old.target,
      // 合并时不算一次「尝试」：重复产生不是她拖着不说
    };
  } else {
    loops.push(loop);
  }
  const open = loops.filter((l) => isOpen(l, loop.createdAt)).slice(-max);
  const closed = loops.filter((l) => !isOpen(l, loop.createdAt)).slice(-20);
  return { ...(state || createIntents()), at: Number(loop.createdAt) || 0, loops: [...closed, ...open] };
}

function patchLoop(state = {}, id, patch) {
  const loops = (state?.loops || []).map((l) => (l.id === id ? { ...l, ...patch } : l));
  return { ...(state || createIntents()), loops };
}

export const markSpoken = (state, id, now) => patchLoop(state, id, { spokenAt: Number(now) || 0 });
export const markDone = (state, id, now) => patchLoop(state, id, { doneAt: Number(now) || 0 });
export const markDropped = (state, id, now) => patchLoop(state, id, { droppedAt: Number(now) || 0 });
export const markMissed = (state, id, now) => patchLoop(state, id, { missedAt: Number(now) || 0 });
export const markTried = (state, id, now) => patchLoop(state, id, { attempts: (Number((state?.loops || []).find((l) => l.id === id)?.attempts) || 0) + 1, lastTryAt: Number(now) || 0 });

/**
 * 到期的废话清掉：tell/ask/do/reply 过了寿命就作废（承诺不在这里——那要认账）。
 * @returns {{state:object, expired:string[]}}
 */
export function expireDue(state = {}, now = 0) {
  const gone = [];
  const loops = (state?.loops || []).map((l) => {
    if (closedOf(l) || l.kind === 'promise') return l;
    if (Number(l.expiresAt) > 0 && now >= Number(l.expiresAt)) {
      gone.push(l.id);
      return { ...l, expiredAt: Number(now) || 0 };
    }
    return l;
  });
  return { state: { ...(state || createIntents()), loops }, expired: gone };
}

// ---- 注入 ----

/**
 * 「你手里还有件事没跟他说」。
 * 只挑到点的、最多两条：一条是「我有个事想告诉他」，两条就快变成汇报了。
 */
export function renderIntentBlock(state = {}, now = 0, { max = MAX_SHOWN } = {}) {
  const due = dueLoops(state, now);
  const rank = { reply: 0, tell: 1, ask: 2, do: 3 };
  const picks = [...due]
    .sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || b.weight - a.weight || b.createdAt - a.createdAt)
    .slice(0, max);
  if (!picks.length) return '';
  const lines = picks.map((l) => {
    const when = whenOf(l.createdAt, now);
    if (l.kind === 'reply') return `- ${when} 他问了你「${l.text}」，你还没回。`;
    if (l.kind === 'ask') return `- ${when} 你有件事想知道：「${l.text}」，还没问也没查。`;
    if (l.kind === 'do') return `- ${when} 你想做件事：${l.text}（还没做）。`;
    return `- ${when} 你想跟他说：「${l.text}」${l.label ? `（${l.label}）` : ''}——还没说。`;
  });
  return ['【你手里还有件事没跟他说】', ...lines, '这些是你自己的事，不是他说的；想不想说都行，说过一次就不再提。'].join('\n');
}

/** 「你答应过他的」：到点了还没兑现，或者已经没做到。没有就不写。 */
export function renderPromiseBlock(state = {}, now = 0) {
  const promises = (state?.loops || []).filter((l) => l.kind === 'promise' && !l.doneAt && !l.droppedAt);
  const rows = [];
  for (const l of promises) {
    if (l.missedAt) rows.push(`- ${whenOf(l.createdAt, now)} 你说「${l.text}」，后来没做到。`);
    else if (Number(l.dueAt) <= Number(now)) rows.push(`- ${whenOf(l.createdAt, now)} 你答应「${l.text}」，到点了，还没兑现。`);
  }
  if (!rows.length) return '';
  return ['【你答应过他的】', ...rows.slice(0, 2), '自己答应的事自己要记得；没做到就认，别装没这回事。'].join('\n');
}

/** 开口提示里那两行（带 id，供她挑一条说）。和注入块分开：一个用来说不说，一个用来挑哪条。 */
export function promptLoopLines(loops = [], now = 0, { max = MAX_SHOWN } = {}) {
  return (loops || []).slice(0, max).map((l) => {
    const when = whenOf(l.createdAt, now);
    if (l.kind === 'reply') return `[${l.id}] ${when} 他问了你「${l.text}」，你还没回`;
    if (l.kind === 'ask') return `[${l.id}] ${when} 你想知道「${l.text}」，还没问也没查`;
    if (l.kind === 'do') return `[${l.id}] ${when} 你想做：${l.text}`;
    return `[${l.id}] ${when} 想跟他说：「${l.text}」`;
  });
}

/** 「他问了你…你还没回」这一类空壳判定：只有话头没有内容，不许发。 */
export function looksLikeShell(message) {
  return /^(我?跟?你说(个)?(事|话)|问你(个)?事|在吗|在不在|我想问你|欸|诶|那个)[。.!！?？…~\s]*$/.test(String(message || '').trim());
}

// ---- 解析 / 销账 ----

/** 读她回复里的 `[想说:…]`。没有就返回原文本、share 为空。尾部的半个标记也剥掉。 */
export function parseShare(reply) {
  const raw = String(reply ?? '');
  const hit = /\[想说\s*[:：]\s*([^\]\n]{1,80})\]/.exec(raw);
  const rest = raw
    .replace(/\[想说\s*[:：]\s*[^\]\n]{1,80}\]/g, '')
    .replace(/\[想说[^\]\n]*$/g, '')   // 被 token 预算切断的残片，不是话
    .replace(/\s+/g, ' ').trim();
  const share = hit ? clip(hit[1], TEXT_MAX) : '';
  if (!share || /^(没有|无|算了|不想说)[。.！!…]?$/.test(share)) return { text: rest, share: '' };
  return { text: rest, share };
}

/** 读 `[想做:…]`（念头层顺手产出的「想做的一件小事」）。 */
export function parseWant(reply) {
  const raw = String(reply ?? '');
  const hit = /\[想做\s*[:：]\s*([^\]\n]{1,80})\]/.exec(raw);
  const rest = raw
    .replace(/\[想做\s*[:：]\s*[^\]\n]{1,80}\]/g, '')
    .replace(/\[想做[^\]\n]*$/g, '')
    .replace(/\s+/g, ' ').trim();
  const want = hit ? clip(hit[1], TEXT_MAX) : '';
  if (!want || /^(没有|无|算了)[。.！!…]?$/.test(want)) return { text: rest, want: '' };
  return { text: rest, want };
}

/** 产后提示：读后感 / 局后感想共用这一行（可选，不想说就整行不写）。 */
export const SHARE_PROMPT_LINE = '最后再加一行，可选——不想说就整行不写，不要写「无」：'
  + '[想说:一句你真想跟他说的话，不超过 40 字]';

/** 念头层用：如果这会儿真想做一件具体的事（不是念头），写一行。 */
export const WANT_PROMPT_LINE = '如果你这会儿真想做一件具体的事（不是念头），最后单独一行：'
  + '[想做:一件你之后真会去做的小事，不超过 40 字]';

const norm = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');

/** 两段话最长的公共连续片段有多长（去掉标点空格后）。 */
export function bestRun(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x.length > y.length) return bestRun(b, a);
  let best = 0;
  for (let i = 0; i < x.length; i += 1) {
    for (let j = 0; j < y.length; j += 1) {
      let k = 0;
      while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k += 1;
      if (k > best) best = k;
    }
  }
  return best;
}

/** 这句话里有没有提到这条 loop（引文锚点命中，或者连续 4 个字对得上）。 */
export function mentions(herText, loop) {
  const t = String(herText ?? '');
  if (!t.trim()) return false;
  const anchor = norm(loop?.anchor);
  if (anchor && norm(t).includes(anchor)) return true;
  const need = Math.min(4, Math.max(2, norm(loop?.text).length));
  return bestRun(t, loop?.text) >= need;
}

/**
 * 她说出口了没有：她这一轮发出的文字里，凡是能对上的 loop 就销账。
 * `reply` 类特殊：他问的那句，她只要回了话就算回过了（不必复述原句）。
 * @returns {{state:object, spoken:string[]}}
 */
export function detectSpoken(state = {}, herText = '', now = 0, { replyLoops = true } = {}) {
  const spoken = [];
  let next = state;
  for (const l of openLoops(state, now)) {
    // 承诺和「想做的事」不靠「她这句话提到过」销账：那要等她真讲给他/真做完。
    if (!['tell', 'ask', 'reply'].includes(l.kind)) continue;
    const hit = l.kind === 'reply' ? replyLoops && Boolean(String(herText || '').trim()) : mentions(herText, l);
    if (!hit) continue;
    next = markSpoken(next, l.id, now);
    spoken.push(l.id);
  }
  return { state: next, spoken };
}

// ---- 开口判定（「有话说」这条通道） ----

/**
 * 她现在该不该因为「手里有件事」先开口。
 * 和等待型（pokeGate）并列，不是替代：两条共用每日总额，各有各的额度。
 */
export function shareGate({
  now = 0, cfg = {}, pokeCfg = {}, loops = [], rhythm = null, state = {},
  lastUserAt = 0, mood = 0.5, history = [],
} = {}) {
  const c = { ...INTENT_DEFAULTS, ...(cfg || {}) };
  const p = { maxPerDay: 3, minGapMinutes: 120, quietFrom: 23, quietTo: 8, moodFloor: 0.25, ...(pokeCfg || {}) };
  const no = (reason) => ({ ok: false, reason });
  if (c.enabled !== true) return no('意图层没开');
  if (rhythm && rhythm.state && rhythm.state !== 'awake') return no(rhythm.state === 'asleep' ? '她这会儿在睡' : '她这会儿不在');
  if (Number(mood) < Number(p.moodFloor)) return no('心情太低，不想说');
  const due = dueLoops({ loops }, now);
  if (!due.length) return no('手里没有要说的事');
  const day = dayKeyOf(now);
  const shareN = state?.share?.day === day ? Number(state.share.n) || 0 : 0;
  if (shareN >= Math.max(1, Number(c.sharePerDay) || 2)) return no('今天说过了');
  const total = state?.day === day ? Number(state.count) || 0 : 0;
  if (total >= Math.max(1, Number(p.maxPerDay) || 3)) return no('今天找他够多了');
  if (inQuietHours(new Date(now).getHours(), p)) return no(`安静时段（${p.quietFrom}:00–${p.quietTo}:00）`);
  if (!Number(lastUserAt)) return no('还没有聊过');
  if (now - Number(lastUserAt) < Math.max(10, Number(c.shareIdleMinutes) || 60) * 60e3) {
    return no('他刚说完话，先别插播');
  }
  const gap = Math.max(10, Number(c.shareMinGapMinutes) || 60) * 60e3;
  if (Number(state?.lastPokeAt) && now - Number(state.lastPokeAt) < gap) return no('刚主动过，先缓一缓');
  // 连发：她已经连着一句在等他，别再拿自己的事压上去。
  if (openThread(history).unanswered > 1) return no('你连着几句在等他');
  const picks = [...due].sort((a, b) => b.weight - a.weight || b.createdAt - a.createdAt).slice(0, MAX_SHOWN);
  return { ok: true, loops: picks, why: `手里有 ${due.length} 件还没说的事` };
}

// ---- 驱力（解释层：只由真事算，不直接生成台词） ----

const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(Number(x)) ? Number(x) : 0));
const round2 = (x) => Math.round(clamp01(x) * 100) / 100;

/**
 * 六股劲儿。全部 = 真事的函数（时间、历史、账本），没有随机、没有自增。
 * 只用来做两件事：排序「先说哪条」，和在开口提示里给一句「你现在最冲的是…」。
 */
export function computeDrives({
  now = 0, lastUserAt = 0, loops = [], novel = {}, game = {}, facts = [],
  relation = {}, emotion = {}, lowBalance = 0,
} = {}) {
  const day = dayKeyOf(now);
  const hours = lastUserAt ? Math.max(0, (now - lastUserAt) / 3600e3) : 0;
  const intimacy = Number(relation.intimacy) || 0;
  // 想他：他安静越久越涨；亲密越高底子越厚。上限 1。
  const miss = round2(clamp01((hours - 1) / 11) * 0.6 + intimacy * 0.4);
  // 想说：手里还没说的事占多重（一条就够用了，三条封顶）。
  const share = round2(clamp01(dueLoops({ loops }, now).reduce((n, l) => n + (Number(l.weight) || 0), 0) / 3));
  // 想显摆：今天真做成了事才算。
  const today = (ms) => ms > 0 && dayKeyOf(ms) === day;
  let proud = 0;
  if (today(Number(game?.last?.at)) && game.last.victory) proud += 0.4;
  if (today(Number(novel?.at)) && Number(novel.readsToday) >= 20) proud += 0.3;
  if (Array.isArray(game?.cleared) && game.cleared.length >= 5) proud += 0.1;
  const proudOut = round2(proud);
  // 好奇：今天还没查过东西，或者手里有一条没查的 ask。
  const searchedToday = (facts?.items || []).some((f) => today(Number(f?.at)));
  let curious = searchedToday ? 0 : 0.25;
  if (openLoops({ loops }, now).some((l) => l.kind === 'ask')) curious += 0.3;
  const curiousOut = round2(curious);
  // 累了：按本地钟。
  const hour = new Date(now).getHours();
  const tired = round2(hour >= 22 ? 0.3 + (hour - 22) * 0.1 : hour < 6 ? 0.4 : 0);
  // 闷着：被晾/被凶/欠着。
  const label = String(emotion?.label || '');
  let sulk = label === '被晾' ? Number(emotion.intensity) || 0.2 : label === '被凶' ? Number(emotion.intensity) || 0.5 : 0;
  if ((Number(relation.debt) || 0) > 0.05) sulk += 0.2;
  if (Number(lowBalance) > 0) sulk += 0.1;
  return { miss, share, proud: proudOut, curious: curiousOut, tired, sulk: round2(sulk) };
}

const DRIVE_WORD = {
  miss: '想他了',
  share: '有件事想跟他说',
  proud: '想让他知道你干了什么',
  curious: '有点想知道点什么',
  tired: '有点累了',
  sulk: '心里有点闷',
};

/** 最冲的那股劲儿（≥0.25 才说，否则空）。 */
export function driveLine(drives = {}) {
  const entries = Object.entries(DRIVE_WORD)
    .map(([k, word]) => [k, Number(drives?.[k]) || 0, word])
    .sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  if (!top || top[1] < 0.25) return '';
  return top[2];
}

// ---- 做完 / 目标 ----

/** 她真做完了一件事：do 类按真事件核销（读书/游戏），没锚点的按时间过期。 */
export function detectDone(state = {}, { now = 0, novel = {}, game = {} } = {}) {
  const done = [];
  let next = state;
  for (const l of openLoops(state, now)) {
    if (l.kind !== 'do') continue;
    let hit = false;
    if (l.about === 'novel') {
      if (l.target?.finishAt) hit = Number(novel.index) + 1 >= Number(l.target.finishAt);
      else if (Number(novel.at) > 0) hit = Number(novel.at) > Number(l.createdAt);
    } else if (l.about === 'game') {
      if (l.target?.level) hit = (game.cleared || []).map(Number).includes(Number(l.target.level));
      else if (Number(game.last?.at) > 0) hit = Number(game.last.at) > Number(l.createdAt);
    }
    if (!hit) continue;
    next = markDone(next, l.id, now);
    done.push(l.id);
  }
  return { state: next, done };
}

/**
 * 跨天目标（M5a）：只从真进度里算，不调模型、不编。
 * 一天最多派生一个；已经在做一件事就不再派生。
 */
export function deriveGoal(state = {}, { now = 0, novel = {}, game = {} } = {}) {
  const day = dayKeyOf(now);
  if (state?.goalDay === day) return null;
  if (openLoops(state, now).some((l) => l.kind === 'do')) return null;
  const name = String(novel?.bookName || '');
  const total = Number(novel?.bookTotal) || 0;
  const at = Number(novel?.index) || 0;
  if (name && total > 0 && at + 1 < total && total - (at + 1) <= 15) {
    return makeLoop({
      kind: 'do', about: 'novel', text: `把《${name}》剩下的 ${total - (at + 1)} 章读完`,
      source: `goal:novel:${novel.bookUrl || name}`, label: name, weight: 0.45, now,
      dueAt: now, expiresAt: now + 7 * 86400e3, target: { finishAt: total },
    });
  }
  const cleared = (game?.cleared || []).map(Number);
  if (cleared.length < 5) {
    const level = cleared.length + 1;
    return makeLoop({
      kind: 'do', about: 'game', text: `把《植物大战僵尸》第 ${level} 关过了`,
      source: 'goal:game', label: '植物大战僵尸', weight: 0.4, now,
      dueAt: now, expiresAt: now + 7 * 86400e3, target: { level },
    });
  }
  return null;
}
