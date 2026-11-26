// 她空闲时做什么：看书，还是玩游戏。
//
// 以前没有「选择」：读书和打游戏是两条独立的定时任务，同一次心跳里会一起跑——
// 结果是她可能一边看小说一边玩游戏。这不叫人，也不叫选择。
//
// 判据只用真事，不掷骰子：
//   1. 上一件做的是什么（换换口味）；
//   2. 这本小说她读到什么态度（P2 的账本：喜欢就接着看，腻了就换）；
//   3. 上一局游戏输赢（通关了想换换；没过会不服气想再打）。
// 平手就看书——那是她原来的习惯。

export const PASTIMES = ['read', 'game'];

/**
 * @param {{canRead?:boolean, canPlay?:boolean, bookAttitude?:number,
 *   lastReadAt?:number, lastGameAt?:number, lastGame?:{at?:number,victory?:boolean}|null,
 *   now?:number}} input
 * @returns {'read'|'game'|'none'}
 */
export function choosePastime({
  canRead = false, canPlay = false, bookAttitude = 0,
  lastReadAt = 0, lastGameAt = 0, lastGame = null, now = 0,
} = {}) {
  if (!canRead && !canPlay) return 'none';
  if (canRead && !canPlay) return 'read';
  if (canPlay && !canRead) return 'game';

  const score = { read: 0, game: 0 };
  // 上一局的输赢最占心思：刚通关就换换口味；刚输了会不服气，还想再来一局（一天内才算数）。
  if (lastGame && Number(lastGame.at) > 0 && now - Number(lastGame.at) < 24 * 3600e3) {
    return lastGame.victory ? 'read' : 'game';
  }
  // 刚做过的先放一放：看书看多了换游戏，游戏打完换书。
  const readAt = Number(lastReadAt) || 0;
  const gameAt = Number(lastGameAt) || 0;
  if (gameAt > readAt) score.read += 1;
  else if (readAt > gameAt) score.game += 1;

  // 这本读到哪儿了：P2 的态度账本，是她自己的真感觉。
  const attitude = Number(bookAttitude) || 0;
  if (attitude >= 0.4) score.read += 1;
  else if (attitude <= -0.2) score.game += 1;

  return score.game > score.read ? 'game' : 'read';
}
