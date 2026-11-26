// 《植物大战僵尸》复刻版的驱动：读 gameState、暂停、收阳光、种一格。
// 纯逻辑（关卡/文字棋盘/指令解析/记录）还在 src/game.js，这里只做「跟页面打交道」。
//
// 为什么能读状态：这个复刻版把 gameState / selectPlant / placePlant 放在全局作用域里，
// 所以不用看图点鼠标，直接调它自己的函数。别的游戏没有这种接口，就走看屏。

import { dayKeyOf } from '../affect/core.js';
import {
  MAX_LEVEL, PLANTS, currentLevel, gameEvents, gameTurnPrompt, lawnText, levelInfo,
  moveAllowed, noteGame, parseMove, resultText, unlockedPlants,
} from '../game.js';

/** 页面里的战况。只读，不改游戏。 */
const STATE_JS = `(() => {
  try {
    if (typeof gameState === 'undefined') return JSON.stringify({ ready: false });
    const s = gameState;
    const cw = (s.cellSize && s.cellSize.width) || 1;
    return JSON.stringify({
      ready: true,
      sun: s.sun, wave: s.wave, maxWaves: s.maxWaves, score: s.score,
      defeated: s.zombiesDefeated, paused: s.isPaused,
      over: s.isGameOver, victory: s.isVictory,
      plants: (s.plants || []).filter((p) => p.element)
        .map((p) => ({ row: p.row, col: p.col, type: p.type })),
      zombies: (s.zombies || []).filter((z) => z.element && z.health > 0)
        .map((z) => ({ row: z.row, col: Math.round((z.x / cw) * 10) / 10, type: z.type, health: z.health })),
    });
  } catch (e) { return JSON.stringify({ ready: false, error: String(e && e.message || e) }); }
})()`;

function pauseJs(on) {
  return `(() => {
    if (typeof gameState === 'undefined') return 'no-game';
    if (gameState.isPaused === ${on ? 'true' : 'false'}) return 'ok';
    document.getElementById('pauseBtn').click();
    return 'toggled';
  })()`;
}

function collectJs() {
  return `(() => {
    const suns = [...document.querySelectorAll('.sun')];
    suns.forEach((el) => el.click());
    return suns.length;
  })()`;
}

function plantJs(type, row, col) {
  return `(() => {
    if (typeof gameState === 'undefined') return 'no-game';
    if (gameState.isPaused) return 'paused';
    const card = [...document.querySelectorAll('.plantCard')].find((c) => c.dataset.plant === ${JSON.stringify(type)});
    const cell = document.querySelector('.cell[data-row="' + ${Number(row)} + '"][data-col="' + ${Number(col)} + '"]');
    if (!card) return 'no-card';
    if (!cell) return 'no-cell';
    card.click();
    cell.click();
    return 'ok';
  })()`;
}

const RE_QUIT = /不玩了|不想玩|算了不玩|退出不玩/;

export function create(config = {}) {
  const spec = {
    id: 'pvz',
    title: '植物大战僵尸',
    stepMs: Math.max(1000, Number(config.stepMs) || 8000),
    maxDecisions: Math.max(10, Number(config.maxDecisions) || 160),
    maxMinutes: Math.max(2, Number(config.maxMinutes) || 30),

    async pause({ browser, on }) {
      await browser.evaluate(pauseJs(on));
    },

    async prepare({ browser, progress }) {
      const lv = levelInfo(currentLevel(progress));
      // 波数交给游戏引擎：第 N 波结束后由它判胜利，不是我们替她算过关。
      await browser.evaluate(`(() => {
        if (typeof gameState === 'undefined') return 'no-game';
        gameState.maxWaves = ${lv.waves};
        if (typeof updateWaveDisplay === 'function') updateWaveDisplay();
        return 'ok';
      })()`);
      await spec.pause({ browser, on: true });
    },

    /** 替她收阳光：真人也是点一下，这只是手快。 */
    async beforeTurn({ browser }) {
      try { await browser.evaluate(collectJs()); } catch { /* 收阳光失败不是一局的错误 */ }
    },

    async read({ browser }) {
      const raw = await browser.evaluate(STATE_JS);
      let snap;
      try { snap = JSON.parse(raw); } catch { throw new Error('游戏状态读不出来'); }
      if (!snap?.ready) throw new Error('游戏还没起来');
      return snap;
    },

    board(state) { return lawnText(state); },

    prompt({ board, progress, leftMs }) {
      const minutesLeft = Math.max(0, Math.round(Number(leftMs) / 60e3));
      return {
        instructions: gameTurnPrompt({ state: progress, minutesLeft }),
        user: `${board}\n\n这一回合做什么？（大概还剩 ${minutesLeft} 分钟）`,
        maxTokens: 1500,
      };
    },

    parse(reply) {
      const raw = String(reply ?? '');
      if (RE_QUIT.test(raw)) return { kind: 'quit' };
      return parseMove(raw);
    },

    async apply({ browser, action, progress }) {
      if (action?.kind !== 'plant') return { ok: true };
      if (!moveAllowed(progress, action)) {
        const names = unlockedPlants(progress).map((k) => PLANTS[k].name).join('、');
        return {
          ok: false,
          note: `「${PLANTS[action.plant]?.name || action.plant}」要后面几关才有，这一关你只能用 ${names}。`,
        };
      }
      const r = await browser.evaluate(plantJs(action.plant, action.row, action.col));
      return r === 'ok'
        ? { ok: true }
        : { ok: false, note: `那一手没种上（${r}）：${PLANTS[action.plant]?.name || action.plant} 第 ${action.row + 1} 行第 ${action.col + 1} 列` };
    },

    done(state) {
      return { over: Boolean(state?.over || state?.victory), victory: Boolean(state?.victory) };
    },

    finish({ state, progress, minutes, notes, t0, t1 }) {
      const lv = levelInfo(currentLevel(progress));
      const material = resultText(state, minutes, lv.n);
      const nextLv = lv.n < MAX_LEVEL ? levelInfo(lv.n + 1) : null;
      const unlocked = nextLv ? nextLv.plants.filter((k) => !lv.plants.includes(k)).map((k) => PLANTS[k].name) : [];
      let facts = state?.victory && nextLv && unlocked.length
        ? `${material}，过了第 ${lv.n} 关，解锁了${unlocked.join('、')}`
        : state?.victory ? `${material}，五关都过了` : material;
      const extra = (notes || []).filter(Boolean).slice(0, 3).join('；');
      if (extra) facts += `（${extra}）`;
      const next = noteGame(progress || {}, {
        now: t1, day: dayKeyOf(t0), snap: state, minutes, reaction: null, level: lv.n,
        events: gameEvents(progress || {}, state),
      });
      return { facts, progress: next, victory: Boolean(state?.victory), level: lv.n };
    },
  };
  return spec;
}
