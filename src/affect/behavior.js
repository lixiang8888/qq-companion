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

  // 心情越低越慢（最多 2.6 倍），戒备越高再慢一点（最多 +60%）。
  const delayMs = Math.round(clamp(baseDelayMs * (1.6 - mood) * (1 + guard * 0.6), 250, 15000));
  // 条数：心情好可以补一句；被戳到（强度高）时更短、只发一条。
  let maxParts = mood >= 0.7 ? 3 : mood >= 0.4 ? 2 : 1;
  if (intensity >= 1) maxParts = Math.min(maxParts, 1);
  // 「他明确要一段长的」是他说的话，比心情更硬：允许破例，但仍然一句一条，不是一篇作文。
  if (room > 0) maxParts = Math.min(5, maxParts + room);

  const reason = `心情${mood >= 0.7 ? '好' : mood >= 0.4 ? '平常' : '低'}${intensity >= 1 ? '·被戳到' : ''}${guard >= 0.4 ? '·戒备' : ''}`;
  return { delayMs, maxParts, reason };
}
