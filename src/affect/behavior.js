// 情绪怎么影响行为（不只是措辞）。
//
// 手册 §4.1 把可改的限定在语用层：句长、节奏、接梗、自我披露。这里只碰「节奏和条数」：
// 心情好 → 回得快、可以多补一句；心情差 → 慢一点、只发一条；戒备高 → 更慢、更短。
// 不碰内容本身。

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * @param {object} st 已结算的四层状态
 * @param {{baseDelayMs?: number, room?: number}} [o] room：这一轮他明确要一段长的，允许她多发几条
 * @returns {{delayMs: number, maxParts: number, reason: string}}
 */
export function replyPlan(st, { baseDelayMs = 800, room = 0 } = {}) {
  const mood = Number(st?.mood?.v ?? 0.5);
  const guard = Number(st?.relation?.guard ?? 0.2);
  const intensity = Number(st?.emotion?.intensity ?? 0);
  const label = String(st?.emotion?.label || '');

  // 心情越低越慢（最多 2.6 倍），戒备越高再慢一点（最多 +60%）。
  let delayMs = Math.round(clamp(baseDelayMs * (1.6 - mood) * (1 + guard * 0.6), 250, 15000));
  // 条数：心情好可以补一句；被戳到（强度高）时更短、只发一条。
  let maxParts = mood >= 0.7 ? 3 : mood >= 0.4 ? 2 : 1;
  if (intensity >= 1) maxParts = Math.min(maxParts, 1);
  // 底气（支配度）：低的时候说不了几句，也更慢；高的时候敢多补一句。
  // 它和标签分工不同——标签说「哪一种」，这个数说「到什么程度、还剩多少」：
  // 被骂一次和被骂两次标签一样，底气不一样。
  const dominance = Number(st?.emotion?.d ?? 0.5);
  if (dominance <= 0.35) {
    delayMs = Math.min(15000, Math.round(delayMs * 1.2));
    maxParts = Math.max(1, maxParts - 1);
  } else if (dominance >= 0.7) {
    delayMs = Math.round(delayMs * 0.85);
    maxParts = Math.min(3, maxParts + 1);
  }
  // 情绪标签必须至少改一个数字。不改的话它就只是一句话，等于没有这个情绪——
  // 「羞」就是按这条长出来的：说不成句，所以只发一条，而且犹豫得比生气更久。
  if (label === '羞') {
    delayMs = Math.min(15000, Math.round(delayMs * 2));
    maxParts = Math.min(maxParts, 1);
  } else if (label === '被凶') {
    delayMs = Math.min(15000, Math.round(delayMs * 1.4));
    maxParts = Math.min(maxParts, 1);
  }
  // 「他明确要一段长的」是他说的话，比心情更硬：允许破例，但仍然一句一条，不是一篇作文。
  if (room > 0) maxParts = Math.min(5, maxParts + room);

  const reason = `心情${mood >= 0.7 ? '好' : mood >= 0.4 ? '平常' : '低'}${intensity >= 1 ? '·被戳到' : ''}${guard >= 0.4 ? '·戒备' : ''}${dominance <= 0.35 ? '·底气低' : dominance >= 0.7 ? '·底气足' : ''}${label ? `·${label}` : ''}`;
  return { delayMs, maxParts, reason };
}
