// 她这一轮玩哪一款。判据全是真事：有没有「想玩某款」的念头、每款上次玩是什么时候。
// 不随机：同样的输入永远给同样的答案，出了问题能复现。

/**
 * @param {Array} games 目录（按 order 排好）
 * @param {{library?: object, prefer?: string, hasVision?: boolean}} o
 *   prefer = 她账本里 do 循环指定的游戏 id；hasVision = 现在能不能看屏（拿不到看图密钥就不选 vision 游戏）
 */
export function pickGame(games = [], { library = {}, prefer = '', hasVision = false } = {}) {
  const list = (games || []).filter((g) => g && (g.kind !== 'vision' || hasVision));
  if (!list.length) return null;
  if (prefer) {
    const hit = list.find((g) => g.id === prefer);
    if (hit) return hit;
  }
  let best = list[0];
  let bestAt = Number(library?.[best.id]?.at) || 0;
  for (const g of list.slice(1)) {
    const at = Number(library?.[g.id]?.at) || 0;
    if (at < bestAt) { best = g; bestAt = at; }
  }
  return best;
}
