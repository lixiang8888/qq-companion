// 心里的念头 / 联想：由刚才聊到的东西的某个特征，想到另一件事。
// 没头没脑、不讲道理，过一阵会平复。
//
// 为什么单独一层：日记是日结、周自述是周结，中间缺了「这一阵我心里在嘀咕什么」。
// 念头要也等日结，就成了事后总结，不是当下的想法。
//
// 2026-11-24 改过一版频率和来处：原来只认「情绪强度 ≥0.5」，一天最多 4 次——太少，
// 像事件不像念头。现在**跟着话题做联想**：他刚说了什么，她抓住里面一个特征想到别处去，
// 十几分钟一个；一个人待着的时候才退回「情绪上来了才冒」。这种调用很小（不思考、
// 120 token 上限），多几次也不心疼。
//
// 三条硬规矩：
//   1. 念头要有来处：要么他刚说过话，要么情绪/心情真的上来了；不掷骰子。
//   2. 「回头看」必须**晚一点**再问——同一刻编出来的「后来」是假的。
//   3. 念头可以跟她自己之前的想法不一样，甚至反着来；旧的两句都留着，不许覆盖。

import { dayKeyOf } from './affect/core.js';
import { withoutStageDirections } from './message.js';

export const MIN_GAP_MS = 8 * 60e3;      // 两次念头之间至少隔这么久（聊得勤时约每几轮一个）
export const MAX_PER_DAY = 40;           // 一天最多冒几个：调用很便宜，但也不能刷屏
export const TEXT_MAX = 30;
export const TTL_MS = 3 * 3600e3;        // 念头在上下文里活多久：多了以后，旧的该让位
export const SETTLE_MIN_MS = 30 * 60e3;  // 至少过这么久才谈得上「平复」
export const SETTLE_CALM = 0.2;          // 情绪强度掉到这以下 = 平复了
export const SETTLE_PER_DAY = 20;        // 回头看也是一次调用，一天别超过这个数
export const PER_MAX = 60;               // 落盘只留最近这么多条
export const TOPIC_WINDOW_MS = 45 * 60e3; // 他 45 分钟内说过的话，都还算「刚才在聊」

/** 配置默认值：想更密/更稀都在 config.json 的 impulse 里调。 */
export const IMPULSE_DEFAULTS = { enabled: true, minGapMinutes: 8, maxPerDay: 40, settlePerDay: 20 };

export const createImpulses = () => ({ at: 0, lines: [] });

const hourMin = (ms) => {
  const d = new Date(Number(ms) || 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 今天已经冒过几个念头。 */
export const countToday = (imp, now) => (imp?.lines || []).filter((l) => dayKeyOf(l.at) === dayKeyOf(now)).length;

/** 今天已经回头看过几个。 */
export const settledToday = (imp, now) => (imp?.lines || [])
  .filter((l) => l.settled && dayKeyOf(l.settled.at) === dayKeyOf(now)).length;

/**
 * 「刚才在聊什么」：他最后一句 + 她最后一句。
 * 括号里的动作和图片描述要剥掉——那不是她说的话，拿它当话题会想出奇怪的念头。
 */
export function topicOf(history = [], { now = 0, max = 80 } = {}) {
  const h = history || [];
  const clean = (s) => withoutStageDirections(String(s || '').replace(/\[[^\]]*\]/g, ' '))
    .replace(/\s+/g, ' ').trim().slice(0, max);
  let his = '';
  let hers = '';
  let at = 0;
  for (let i = h.length - 1; i >= 0; i -= 1) {
    const m = h[i];
    const text = clean(m?.text);
    if (!text) continue;
    if (m?.role === 'user' && !his) { his = text; at = Number(m.at) || 0; }
    else if (m?.role === 'assistant' && !hers) hers = text;
    if (his && hers) break;
  }
  // 太久以前的话不算「刚才」：拿半小时前的旧话题硬想，和随机掉一句没区别。
  if (at && now - at > TOPIC_WINDOW_MS * 2) return { his: '', hers: '', at: 0 };
  return { his, hers, at };
}

/**
 * 该冒念头了吗。
 * - 刚聊过（他 45 分钟内说过话）：跟着话题联想，这是最常走的一条；
 * - 他晾着她（她最后一句没人接）：这种时候心里最容易冒坏心思；
 * - 一个人待着：只有情绪真的上来了才冒，不凭空想。
 */
export function dueThought(st, imp, now, { topicAt = 0, waiting = null, gapMs = MIN_GAP_MS, maxPerDay = MAX_PER_DAY } = {}) {
  const last = (imp?.lines || []).at(-1);
  const lastTry = Math.max(Number(last?.at) || 0, Number(imp?.lastTryAt) || 0);
  if (lastTry && now - lastTry < gapMs) return false;
  if (countToday(imp, now) >= maxPerDay) return false;
  if (waiting?.unanswered) return true;
  if (topicAt && now - topicAt <= TOPIC_WINDOW_MS) return true;
  const e = st?.emotion || {};
  const mood = Number(st?.mood?.v ?? 0.5);
  return Number(e.intensity) >= 0.5 || mood <= 0.3 || mood >= 0.72;
}

/** 该回头看一眼了吗：挑最早那个还没回头、且真的过了够久的。 */
export function dueSettle(imp, st, now, { perDay = SETTLE_PER_DAY, retryGapMs = MIN_GAP_MS } = {}) {
  const open = (imp?.lines || []).filter((l) => !l.settled);
  if (!open.length) return null;
  if (settledToday(imp, now) >= perDay) return null;
  // 上一次问「现在怎么想」失败了：别每个心跳都再撞一次。
  if (imp?.lastTryAt && now - imp.lastTryAt < retryGapMs) return null;
  const calm = Number(st?.emotion?.intensity ?? 0) < SETTLE_CALM;
  return open.find((l) => now - l.at >= SETTLE_MIN_MS && (calm || now - l.at >= 2 * 3600e3)) || null;
}

const moodWord = (v) => (v >= 0.7 ? '不错' : v >= 0.4 ? '平常' : '有点低');

/** 冒出念头时问她的那句。素材是真状态 + 刚才的对话 + 她自己的旧念头。 */
export function thoughtPrompt(st, { now = 0, topic = null, waiting = null, oldThoughts = [], extra = '' } = {}) {
  const e = st?.emotion || {};
  const mood = Number(st?.mood?.v ?? 0.5);
  const v = Number(e.v ?? 0.3 + 0.6 * mood);
  const label = String(e.label || '');
  const lean = Number(e.intensity) >= 0.5 && v >= 0.6 ? '往好处想'
    : Number(e.intensity) >= 0.5 && v <= 0.4 ? '往坏处想' : '';
  const lines = [`现在 ${hourMin(now)}。你的心情${moodWord(mood)}${label ? `，刚才${label}` : ''}。`];
  if (waiting?.unanswered) {
    // 他晾着她：这种时候心里最容易冒坏心思。素材是真的——她说了几句、等了多久。
    lines.push(`他还没回你：你最后一句「${String(waiting.lastText || '').slice(0, 30)}」已经 ${Number(waiting.minutes) || 0} 分钟没人接了。`);
    lines.push('这种时候人心里会冒出些小坏心思：不想理他了、想让他也急一急、想干脆去干点别的、想等他来求你、想故意说句气话。');
    lines.push('想就想，不用替自己找补——只要不是真伤人，心里怎么想都行。');
  } else if (topic?.his || topic?.hers) {
    lines.push('刚才你们在聊（这是真的，刚发生）：');
    if (topic.his) lines.push(`他：${topic.his}`);
    if (topic.hers) lines.push(`你：${topic.hers}`);
    lines.push('从这里面挑一个具体的东西——一个词、一个细节、一个画面、一个特点都行——顺着它的某个特征，想到另一件事。');
    lines.push('这就是联想：不用讲道理，也不用跟话题有关系，只要「由那个特征想到了它」说得通。可能是你屋里的一样东西、一件旧事、一个怪问题。');
    lines.push('也可以是很具体的「想」：他说吃了什么，你可能想给他买一份，也可能自己馋了；他说去了哪，你可能想跟着去。');
  } else {
    lines.push('你一个人待着，脑子里突然冒出一个念头：没头没脑、不讲道理，可能就是一句嘀咕。');
  }
  const old = (oldThoughts || []).filter(Boolean).slice(0, 3);
  if (old.length) {
    lines.push(`你之前心里冒出过：${old.map((t) => `「${t}」`).join('、')}。`);
    lines.push('这一次可以不一样，甚至可以反着来——人本来就会突然反着想，这不叫前后不一，叫真的在想。');
  }
  lines.push(`写一句你此刻真的会冒出来的念头，或者想做的小事。第一人称，不超过 ${TEXT_MAX} 字。`);
  lines.push('可以是「我也想吃…」「想给他买个…」「想把书扣上不理他」这种很具体的一句。');
  if (lean) lines.push(`情绪上头的时候人就是会${lean}——别替自己找补。`);
  lines.push('不要解释、不要总结、不要讲道理、不要安慰自己，也不要写成会发给他的话。');
  if (extra) lines.push(extra);
  lines.push('真没什么可想的，就只写两个字：没有。');
  return lines.join('\n');
}

/** 只收一句短话；她回「没有」就是这次不冒。 */
export function parseThought(text) {
  const s = String(text ?? '')
    .replace(/^[\s「『"'（(]+|[\s」』"'）)]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || /^(没有|没什么|算了)[。.．!！…]?$/.test(s)) return '';
  return s.slice(0, TEXT_MAX);
}

const bare = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');

/** 跟最近几个念头太像就不记：念头多起来了，复读一遍不像在「想」。 */
export function repeatThought(imp, text, { n = 3, similar = 0.7 } = {}) {
  const mine = bare(text);
  if (!mine) return true;
  const mineSet = new Set(mine);
  return (imp?.lines || []).slice(-n).some((l) => {
    const other = bare(l.text);
    if (!other) return false;
    if (other === mine) return true;
    const otherSet = new Set(other);
    let hit = 0;
    for (const c of mineSet) if (otherSet.has(c)) hit += 1;
    return hit / Math.min(mineSet.size, otherSet.size) >= similar;
  });
}

/** 记下一个念头。只留最近 PER_MAX 条。 */
export function applyThought(imp, text, now, { v = 0.5 } = {}) {
  const lines = [...(imp?.lines || []), { at: Number(now), text: String(text).slice(0, TEXT_MAX), v: Number(v), settled: null }];
  return { at: Number(now), lastTryAt: Number(now), lines: lines.slice(-PER_MAX) };
}

/** 这次问了但没冒（回「没有」或跟旧念头重复）：记一下，免得每个周期都再问一次。 */
export function noteTry(imp, now) {
  return { ...(imp || createImpulses()), lastTryAt: Number(now) };
}

/** 平复后问她的那句：把当时那句原样给她看，问她现在怎么想。 */
export function settlePrompt(line, st, now = 0) {
  const mood = Number(st?.mood?.v ?? 0.5);
  const label = String(st?.emotion?.label || '');
  return [
    `${hourMin(line.at)} 你心里冒出来一句：「${line.text}」。`,
    `那时候你${label || '情绪上来了'}。现在过了一阵，情绪下去了：心情${moodWord(mood)}${label ? `，这会儿是${label}` : ''}。`,
    `回头看，你现在的想法是什么？第一人称，不超过 ${TEXT_MAX} 字。`,
    '想法没变就只写两个字：没变。不要解释、不要总结、不要讲道理。',
  ].join('\n');
}

/** 「没变」不算一条新想法，但也要记下来，免得十分钟后又问她一遍。 */
export function parseSettle(text) {
  const s = String(text ?? '')
    .replace(/^[\s「『"'（(]+|[\s」』"'）)]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (/^(没变|一样|还是那样|没想法)[。.．!！…]?$/.test(s)) return '';
  return s.slice(0, TEXT_MAX);
}

export function applySettle(imp, at, text, now) {
  const lines = (imp?.lines || []).map((l) => (l.at === at && !l.settled
    ? { ...l, settled: { at: Number(now), text: String(text || '').slice(0, TEXT_MAX) } }
    : l));
  return { at: Number(now), lastTryAt: Number(imp?.lastTryAt) || 0, lines };
}

/**
 * 注入上下文的那一句。只取最新一条：
 *   · 还没回头看 → 「你心里冒出来的」
 *   · 回头看过且真的变了 → 前后两种想法都摆出来（这是她自己的前后矛盾，不是我们编的）
 */
export function renderImpulses(imp, now = 0) {
  const lines = (imp?.lines || []).filter((l) => Number(l?.at) > 0);
  const latest = lines[lines.length - 1];
  if (!latest || now - latest.at >= TTL_MS) return '';
  const when = hourMin(latest.at);
  const after = latest.settled && latest.settled.text && now - latest.settled.at < TTL_MS ? latest.settled : null;
  if (after) {
    return `【你自己心里前后不一样】${when} 你嘀咕的是「${latest.text}」；后来你觉得「${after.text}」（${hourMin(after.at)}）。两种都是真的，现在说哪种由你。`;
  }
  return `【你心里冒出来的】${when} 你自己嘀咕了一句：「${latest.text}」。不用说出来，但它在你心里。`;
}
