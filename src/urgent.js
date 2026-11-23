// 她着急的时候，怎么叫你。
//
// QQ 没有「机器人拨语音通话」这个能力——QQ 官方 API 没有 RTC、协议库（Lagrange 等）的
// Voice Call / FriendVoiceCall 都标着没实现、SnowLuma 2.4.0 里也没有任何呼叫接口。
// 所以"着急想找你"能递到你眼前的，只有这两级：
//   · 私聊戳一戳（轻，手机/客户端有提示）
//   · 私聊窗口抖动（重，QQ 里最接近打电话的强提醒；会抢焦点，所以一天只抖一次）
//
// 判据全是真事，不掷骰子：
//   1. 她说的最后一句还没人回（从历史现算，见 proactive.openThread）；
//   2. 她心里真的着急：情绪强度够高、而且是负向的（只是心情好不算急）；
//   3. 一段"没回"里先戳，戳过半小时还没回，才升级成抖窗口。
//
// 抖是事实驱动的升级，不是再赌一次情绪：她戳的时候确实急，半小时没人理，这件事本身
// 就够升级了——情绪半衰期会把强度吹散，但"她等过"不会。

import { dayKeyOf } from './affect/core.js';
import { inQuietHours, openThread } from './proactive.js';

const MIN = 60e3;

export const DEFAULTS = {
  enabled: false,
  intensity: 0.6,          // 情绪强度到这个数，才算「着急」
  valence: 0.45,           // 而且情绪是负向的（v 低于这个数）；只是心情好不算急
  minWaitMinutes: 3,       // 她说完至少等这么久才戳：刚说完就戳是催命
  minGapMinutes: 30,       // 两次「叫你」之间
  shakeAfterMinutes: 30,   // 戳了这么久还没回，升级成窗口抖动
  maxPerDay: 3,            // 一天最多叫几次（含抖动）
  maxShakePerDay: 1,       // 窗口抖动一天最多一次（会吵人）
  quietFrom: 23,           // 安静时段不叫（跟主动搭话同一条线）
  quietTo: 8,
};

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const mins = (ms) => Math.round(ms / MIN);

/**
 * 现在该不该叫他一下。
 * @param {{now?:number, history?:object[], emotion?:{label?:string,v?:number,intensity?:number},
 *   state?:object, cfg?:object}} input
 * @returns {{ok:boolean, reason?:string, kind?:'poke'|'shake', why?:string,
 *   waited?:number, open?:{unanswered:number,lastAt:number,lastText:string}}}
 */
export function shouldNudge({ now = 0, history = [], emotion = {}, state = {}, cfg = DEFAULTS } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const no = (reason) => ({ ok: false, reason });
  if (!c.enabled) return no('未开启');
  const open = openThread(history);
  if (!open.unanswered || !open.lastAt) return no('没有等她回话的话');
  const waited = now - open.lastAt;
  if (waited < c.minWaitMinutes * MIN) return no(`刚说完 ${mins(waited)} 分钟，先等等`);
  if (inQuietHours(new Date(now).getHours(), c)) return no(`安静时段（${c.quietFrom}:00–${c.quietTo}:00）`);

  const day = dayKeyOf(now);
  const nudge = state.nudge || {};
  const today = nudge.day === day ? num(nudge.n) : 0;
  if (today >= c.maxPerDay) return no('今天叫得够多了');
  const lastAt = num(nudge.lastAt);
  if (lastAt && now - lastAt < c.minGapMinutes * MIN) return no('刚叫过，先缓缓');

  // 同一次「没回」里：先戳，再抖；抖过就等他说，不许没完。
  if (lastAt && lastAt >= open.lastAt) {
    if (nudge.kind === 'shake') return no('已经抖过窗口了，等他说');
    if (now - lastAt < c.shakeAfterMinutes * MIN) return no(`戳过还不到 ${c.shakeAfterMinutes} 分钟`);
    const shakes = nudge.shakeDay === day ? num(nudge.shakeN) : 0;
    if (shakes >= c.maxShakePerDay) return no('今天抖过窗口了');
    return { ok: true, kind: 'shake', why: `戳过 ${mins(now - lastAt)} 分钟还没回，急起来了`, waited, open };
  }

  // 新的「没回」：要不要从头叫，得看现在心里急不急。
  const intensity = num(emotion?.intensity);
  const v = Number(emotion?.v);
  if (!(intensity >= c.intensity && Number.isFinite(v) && v <= c.valence)) return no('心里还没那么急');
  return {
    ok: true,
    kind: 'poke',
    why: `心里急（${String(emotion?.label || '说不上来')} ${intensity.toFixed(1)}），他 ${mins(waited)} 分钟没接`,
    waited,
    open,
  };
}

/** 真叫过了：记一笔（叫了几次、什么时候、戳还是抖）。 */
export function noteNudge({ state = {}, now = 0, kind = 'poke' } = {}) {
  const day = dayKeyOf(now);
  const same = state.nudge?.day === day;
  const n = same ? num(state.nudge.n) : 0;
  // 抖窗口的当日计数要跨「叫了几次」保留：同一天里先抖过，晚些换一段事也不许再抖。
  const prevShakes = state.nudge?.shakeDay === day ? num(state.nudge.shakeN) : 0;
  const shakeN = kind === 'shake' ? prevShakes + 1 : prevShakes;
  return {
    ...state,
    nudge: {
      day,
      n: n + 1,
      lastAt: now,
      kind,
      ...(shakeN > 0 ? { shakeDay: day, shakeN } : {}),
    },
  };
}
