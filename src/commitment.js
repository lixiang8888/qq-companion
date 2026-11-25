// 她说的话要落回状态：去睡了就真的去睡、答应过的事有账、没做到要认。
//
// 以前的洞（2026-11-25 审查）：她说「我先睡了」「回来给你讲」，系统里什么都不变——
// 下一句还是秒回，约定没有任何记录；她的台词和她的日常不同源。这一层补的就是这个方向。
//
// 只有明确句式才认（规则表），模糊的一律不写状态：宁可少一次「像人」，也不写一个假状态。
// 纯函数 + 注入时钟，状态由 host 落 rhythm.json / intents.json。

import { isOpen, makeLoop } from './intent.js';

export const RHYTHM_DEFAULTS = { enabled: true, wakeHour: 7, awayMinutes: 45 };
// 被吵醒之后多久内还带着困意。
export const WOKE_MS = 15 * 60e3;

export const createRhythm = () => ({ at: 0, state: 'awake', since: 0, until: 0, reason: '', claim: '', wokeBy: '' });

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const clock = (ms) => {
  const d = new Date(Number(ms) || 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const startOfDay = (ms) => {
  const d = new Date(Number(ms) || 0);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const DAY = 86400e3;

/** 下一次自然醒：wakeHour 点；已经过了就是明天。 */
export function nextWakeAt(now, { wakeHour = 7 } = {}) {
  const today = startOfDay(now) + wakeHour * 3600e3;
  return today > now ? today : today + DAY;
}

/**
 * 这句话是不是在说「我去睡了/我去忙一会儿」。
 * 必须有第一人称或者「晚安」——「你去睡吧」是她催他睡，不能把她自己弄睡着。
 * @returns {null|{state:'asleep'|'away', minutes:number, claim:string}}
 */
export function parseRhythmClaim(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const asleep = /(^|[，。！!？?\s])晚安/.test(s)
    || /(我|俺)(先|去|要|该|得|就)?(睡|睡觉|睡啦|睡了)/.test(s)
    || /(^|[，。！!？?\s])(先|去|该)睡了/.test(s);
  if (asleep) return { state: 'asleep', minutes: 0, claim: clip(s, 40) };
  const away = /(我|俺)(去|先)?(吃饭|洗澡|忙|出门|收拾|上号|上个厕所)/.test(s)
    || /等我(一下|一会儿|会儿|几分钟)/.test(s)
    || /(马上|一会(儿)?|等会(儿)?|待会(儿)?)回来/.test(s);
  if (away) return { state: 'away', minutes: 0, claim: clip(s, 40) };
  return null;
}

/** 吃下她的这句「去睡了 / 去忙了」。 */
export function applyClaim(rhythm, claim, now, cfg = RHYTHM_DEFAULTS) {
  if (!claim) return null;
  if (claim.state === 'asleep') {
    return {
      at: Number(now) || 0, state: 'asleep', since: Number(now) || 0,
      until: nextWakeAt(now, cfg), reason: '她说要去睡', claim: claim.claim, wokeBy: '',
    };
  }
  const minutes = Math.max(5, Number(claim.minutes) || Number(cfg.awayMinutes) || 45);
  return {
    at: Number(now) || 0, state: 'away', since: Number(now) || 0,
    until: Number(now) + minutes * 60e3, reason: '她说去忙一会儿', claim: claim.claim, wokeBy: '',
  };
}

/** 他发消息把她弄醒了。本来醒着就原样返回 null。 */
export function wakeRhythm(rhythm, now, { by = 'his message' } = {}) {
  if (!rhythm || !rhythm.state || rhythm.state === 'awake') return null;
  return {
    ...rhythm,
    at: Number(now) || 0, state: 'awake', since: Number(now) || 0, until: 0,
    reason: by === 'his message' ? '被他的消息吵醒' : '到点了', wokeBy: by,
  };
}

/** 到点了自己醒（睡到早上 / 说去忙的那段时间过完）。没变化返回 null。 */
export function advanceRhythm(rhythm, now, cfg = RHYTHM_DEFAULTS) {
  if (!rhythm || !rhythm.state || rhythm.state === 'awake') return null;
  const until = Number(rhythm.until) || 0;
  if (!until || Number(now) < until) return null;
  return {
    ...rhythm,
    at: Number(now) || 0, state: 'awake', since: until, until: 0,
    reason: rhythm.state === 'asleep' ? '睡到自然醒' : '忙完了', wokeBy: 'timeout',
  };
}

/** 注入用：睡着 / 不在 / 刚被吵醒。清醒且没什么特别的事就返回空串。 */
export function rhythmLine(rhythm, now = 0) {
  if (!rhythm || !rhythm.state) return '';
  if (rhythm.state === 'awake') {
    if (rhythm.wokeBy === 'his message' && Number(now) - Number(rhythm.since) < WOKE_MS) {
      return `【你刚被吵醒】${clock(rhythm.since)} 起你在睡，是他一条消息把你弄醒的。话可能会短一点、带点困；想再睡回去也可以说。`;
    }
    return '';
  }
  if (rhythm.state === 'asleep') {
    return `【你现在是睡着的】${clock(rhythm.since)} 你说「${clip(rhythm.claim, 40) || '去睡了'}」。你在睡——他要是这会儿发消息，你可以迷迷糊糊回一句，也可以装睡；回不回你自己定。`;
  }
  const until = Number(rhythm.until) > 0 ? `，大概 ${clock(rhythm.until)} 回来` : '';
  return `【你这会儿不在】${clock(rhythm.since)} 你说「${clip(rhythm.claim, 40) || '去忙一会儿'}」${until}。`;
}

/**
 * 这句话里有没有她自己许下的承诺。「你去睡吧」「明天见」不算。
 * @returns {null|{claim:string, dueAt:number}}
 */
export function parsePromise(text, now = 0) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s || s.length < 4) return null;
  if (/[?？]\s*$/.test(s)) return null;
  // 他许的愿/他答应的，不是她的账
  if (/(你|他)(答应|说好|保证)/.test(s) && !/(我|俺)(答应|说好|保证)/.test(s)) return null;
  const mine = /((回来|回头|明天|改天|下次|晚点|等会(儿)?|待会(儿)?|一会儿)[^。！？!?]{0,12}(说|讲|聊|告诉|给你|带你|发你|教你))/
    .test(s)
    // 「我答应你」这种空口的不算账：后面得跟一件具体会做的事（说/讲/给/带/陪…）。
    || (/(我|俺)(答应|说好|保证|一定)[^。！？!?]{0,20}/.test(s)
      && /(说|讲|聊|告诉|给|带|教|发|陪|请|买|做|去|来)/.test(s));
  if (!mine) return null;
  const claim = clip(s, 40);
  let dueAt;
  if (/明天/.test(s)) {
    dueAt = startOfDay(now) + DAY + 20 * 3600e3;
  } else if (/(改天|下次)/.test(s)) {
    dueAt = Number(now) + DAY;
  } else if (/(回来|回头|晚点|等会(儿)?|待会(儿)?|一会儿)/.test(s)) {
    dueAt = Number(now) + 2 * 3600e3;
  } else {
    dueAt = Number(now) + 4 * 3600e3;
  }
  return { claim, dueAt };
}

/** 把一句承诺落成 loop。createAt/expiresAt 都留够，过期不删，要认账。 */
export function promiseLoop(promise, { now = 0 } = {}) {
  if (!promise?.claim) return null;
  return makeLoop({
    kind: 'promise', about: 'self', text: promise.claim, source: `promise:${Math.round(Number(now) || 0)}`,
    weight: 0.6, now, dueAt: promise.dueAt, expiresAt: Number(promise.dueAt) + 7 * DAY,
  });
}

/** 到点还没兑现的（还没到「没做到」，只是该做了）。 */
export function duePromises(state = {}, now = 0, cfg = {}) {
  const grace = Number(cfg.promiseGraceMs) || 24 * 3600e3;
  return (state?.loops || []).filter((l) => l.kind === 'promise' && isOpen(l, now)
    && Number(l.dueAt) <= Number(now) && Number(now) < Number(l.dueAt) + grace);
}

/** 过了宽限期还没做到：该认账了（每条只会被返一次，host 负责 markMissed）。 */
export function latePromises(state = {}, now = 0, cfg = {}) {
  const grace = Number(cfg.promiseGraceMs) || 24 * 3600e3;
  return (state?.loops || []).filter((l) => l.kind === 'promise' && isOpen(l, now)
    && Number(l.dueAt) + grace <= Number(now));
}

/** 没做到的那一下给什么情绪：强度随件数涨，标签固定「亏欠」。 */
export function missedEmotion(count = 1) {
  const n = Math.max(1, Number(count) || 1);
  return {
    v: 0.34, a: 0.3, d: 0.28,
    intensity: Math.min(1, 0.45 + 0.2 * n),
    label: '亏欠',
  };
}

/** 欠着的分量（进 relation.debt，按天自己淡）。 */
export const debtForMisses = (count = 1) => Math.min(0.3, 0.06 * Math.max(1, Number(count) || 1));
