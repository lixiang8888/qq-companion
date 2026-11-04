// 主动搭话：三道闸没全过，就一个字都不发。
//
// 陪伴最容易坏在「太热情」上。这里的顺序是：默认关闭 → 安静时段 → 每日上限 →
// 冷却 → 他刚说完等我回（我先说就不追） → 够久没说话 → 心情不至于不想理人。

import { sanitizeSecrets } from './memory/sanitize.js';
import { dayKeyOf } from './affect/core.js';

export const DEFAULTS = {
  enabled: false,
  minIdleMinutes: 180,
  maxPerDay: 3,
  minGapMinutes: 120,
  quietFrom: 23,
  quietTo: 8,
  moodFloor: 0.25,
};

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

export function inQuietHours(hour, { quietFrom, quietTo }) {
  if (quietFrom === quietTo) return false;
  return quietFrom < quietTo ? hour >= quietFrom && hour < quietTo : hour >= quietFrom || hour < quietTo;
}

/**
 * @param {object} o
 * @param {number} o.now
 * @param {object} o.cfg 见 DEFAULTS
 * @param {number} o.lastUserAt 他最后一条消息的时间
 * @param {number} o.lastBotAt 我最后一条的时间
 * @param {{day?: string, count?: number, lastPokeAt?: number}} o.pokes
 * @param {number} o.mood
 */
export function pokeDecision({ now, cfg = DEFAULTS, lastUserAt = 0, lastBotAt = 0, pokes = {}, mood = 0.5 }) {
  const c = { ...DEFAULTS, ...cfg };
  const no = (reason) => ({ ok: false, reason });

  if (!c.enabled) return no('未开启');
  if (!lastUserAt) return no('还没有聊过');
  const hour = new Date(now).getHours();
  if (inQuietHours(hour, c)) return no(`安静时段（${c.quietFrom}:00–${c.quietTo}:00）`);
  if (mood < c.moodFloor) return no('心情太低，不想主动');
  if (pokes.day === dayOf(now) && (pokes.count || 0) >= c.maxPerDay) return no('今天已经找过了');
  if (pokes.lastPokeAt && now - pokes.lastPokeAt < c.minGapMinutes * 60e3) return no('冷却中');
  if (lastBotAt > lastUserAt) return no('上一条是我说的，等他说');
  const idleMs = now - lastUserAt;
  if (idleMs < c.minIdleMinutes * 60e3) return no('还没那么久');

  return { ok: true, idleHours: Math.round(idleMs / 36e5), reason: '可以主动找他' };
}

/** 给模型的提醒文本。它只是「有人在你耳边说可以找他」，不是一条用户消息。 */
export function pokePrompt({ idleHours, memory = '' }) {
  const hint = memory ? `可以提一句：${sanitizeSecrets(memory).slice(0, 60)}。` : '可以说说你自己刚想到的事。';
  return `【系统提醒·不是他说的】你已经 ${idleHours} 小时没和他说话了。${hint}一两句就够，别用模板；不想说就只回 [沉默]。`;
}

/** 模型选择沉默时返回 true。 */
export function isSilent(reply) {
  return !String(reply || '').replace(/[\[【（(]\s*沉默\s*[\]】）)]/g, '').trim();
}

export function notePoke({ pokes = {}, now }) {
  const day = dayOf(now);
  return {
    day,
    count: (pokes.day === day ? pokes.count || 0 : 0) + 1,
    lastPokeAt: now,
  };
}
