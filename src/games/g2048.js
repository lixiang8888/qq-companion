// 《2048》（gabrielecirulli/2048，MIT）的驱动。
// 状态不用改它的代码：它每走一步都会把整盘存进 localStorage 的 gameState，
// 我们读那份存档；操作走 CDP 的方向键（它监听 keydown.which，真按键才对得上）。

const DIR_KEY = { 上: 'ArrowUp', 下: 'ArrowDown', 左: 'ArrowLeft', 右: 'ArrowRight' };
const RE_MARK = /\[按\s*[:：]\s*(上|下|左|右)\s*\]/;
const RE_QUIT = /不玩了|不想玩|算了不玩|退出不玩/;

const READ_JS = `(() => {
  const msg = document.querySelector('.game-message');
  const over = !!msg && msg.classList.contains('game-over');
  const won = !!msg && msg.classList.contains('game-won');
  let saved = null;
  try { const raw = localStorage.getItem('gameState'); if (raw) saved = JSON.parse(raw); } catch (e) {}
  const cells = Array.isArray(saved && saved.grid && saved.grid.cells) ? saved.grid.cells : null;
  let score = Number(saved && saved.score);
  if (!Number.isFinite(score)) {
    const t = (document.querySelector('.score-container')?.textContent || '0');
    score = Number((t.match(/\\d+/) || ['0'])[0]) || 0;
  }
  const tiles = [...document.querySelectorAll('.tile-inner')].map((el) => Number(el.textContent) || 0);
  return JSON.stringify({
    ready: Boolean(saved || over || won),
    over, won, score, cells,
    maxTile: tiles.length ? Math.max(...tiles) : 0,
  });
})()`;

export function parse2048(reply = '') {
  const raw = String(reply ?? '');
  if (RE_QUIT.test(raw)) return { kind: 'quit' };
  const hit = RE_MARK.exec(raw);
  if (hit) return { kind: 'move', dir: hit[1], key: DIR_KEY[hit[1]] };
  // 允许她只回一个「左」字：口语比标记更自然。
  const loose = /(上|下|左|右)/.exec(raw);
  return loose ? { kind: 'move', dir: loose[1], key: DIR_KEY[loose[1]] } : null;
}

/** 把存档的 cells 画成文字棋盘：行是 y，列是 x。 */
export function board2048(state = {}) {
  const cells = state?.cells;
  if (!Array.isArray(cells)) return '';
  const rows = [];
  for (let y = 0; y < 4; y += 1) {
    const row = [];
    for (let x = 0; x < 4; x += 1) {
      const tile = cells[x]?.[y];
      row.push(tile && Number(tile.value) ? String(Number(tile.value)) : '.');
    }
    rows.push(row.join(' '));
  }
  return rows.join('\n');
}

export function create() {
  return {
    id: 'g2048',
    title: '2048',
    stepMs: 900,
    maxDecisions: 160,
    maxMinutes: 25,

    async prepare() { /* 新 profile 每次都是新盘，不用重置 */ },

    async read({ browser }) {
      const raw = await browser.evaluate(READ_JS);
      let state;
      try { state = JSON.parse(raw); } catch { throw new Error('2048 状态读不出来'); }
      if (!state?.ready) throw new Error('2048 还没起来');
      return state;
    },

    board(state) { return board2048(state); },

    prompt({ state, progress }) {
      const best = Math.max(Number(progress?.best) || 0, Number(state?.score) || 0);
      return {
        instructions: [
          '你在玩《2048》：4×4 的格子，每按一个方向，所有数字往那边滑，相同的数字撞在一起会合并成两倍。',
          '每滑一次，空格里会冒出一个 2 或 4。凑出 2048 就赢；格子满了又滑不动就输。',
          '棋盘按行从上到下、列从左到右；. 是空格。',
          '只回一行，不要解释：[按:左]（左/右/上/下）。',
        ].join('\n'),
        user: `${board2048(state)}\n\n分数 ${Number(state?.score) || 0}${best ? `，你玩过的最好 ${best} 分` : ''}。这一下往哪边推？`,
        maxTokens: 800,
      };
    },

    parse(reply) { return parse2048(reply); },

    async apply({ browser, action }) {
      await browser.key(action.key);
      return { ok: true };
    },

    done(state) {
      if (state?.won) return { over: true, victory: true };
      if (state?.over) return { over: true, victory: false };
      return { over: false };
    },

    finish({ state, progress, decisions, minutes }) {
      const score = Number(state?.score) || 0;
      const maxTile = Number(state?.maxTile) || 0;
      const end = state?.won ? '（凑出 2048 了）' : state?.over ? '（推死了）' : '（时间到了，还活着）';
      const facts = `《2048》玩了 ${Math.max(1, Math.round(minutes))} 分钟，推了 ${decisions} 手，最后 ${score} 分${end}${maxTile ? `，这一局最大数字 ${maxTile}` : ''}`;
      return {
        facts,
        victory: Boolean(state?.won),
        progress: {
          ...(progress || {}),
          plays: (Number(progress?.plays) || 0) + 1,
          best: Math.max(Number(progress?.best) || 0, score),
          lastScore: score,
        },
      };
    },
  };
}
