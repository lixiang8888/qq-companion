// 《推箱子》（mashukui/web-games，MIT）的驱动。
// 它自带只读探针 window.__st()（关卡、步数、推数、箱子/目标计数、死局标记），
// 棋盘本身是 DOM 格子，按 class 还原成 ASCII；操作走 CDP 方向键。

const DIR_KEY = { 上: 'ArrowUp', 下: 'ArrowDown', 左: 'ArrowLeft', 右: 'ArrowRight' };
const RE_MARK = /\[走\s*[:：]\s*(上|下|左|右)\s*\]/;
const RE_UNDO = /\[撤\s*[:：]?\s*\]|撤销/;
const RE_RESTART = /重来|重新开始/;
const RE_QUIT = /不玩了|不推了|不想玩|算了|退出/;

const READ_JS = `(() => {
  const st = typeof window.__st === 'function' ? window.__st() : null;
  const cells = [...document.querySelectorAll('#board > div')].map((el) => {
    const crate = el.querySelector('.crate');
    return {
      wall: el.classList.contains('wall'),
      goal: el.classList.contains('goal'),
      box: !!crate && crate.style.display !== 'none',
      on: !!crate && crate.classList.contains('on'),
      hero: !!el.querySelector('.hero'),
    };
  });
  return JSON.stringify({ ...(st || {}), ready: !!st, cells });
})()`;

/** 把格子还原成推箱子的标准字符画：# 墙 . 目标 $ 箱子 * 箱子在目标上 @ 你 + 你在目标上 */
export function boardText(cells = [], width = 0) {
  const w = Number(width) || 0;
  if (!w || !Array.isArray(cells) || !cells.length) return '';
  const rows = [];
  for (let y = 0; y < Math.ceil(cells.length / w); y += 1) {
    let row = '';
    for (let x = 0; x < w; x += 1) {
      const c = cells[y * w + x] || {};
      let ch = ' ';
      if (c.wall) ch = '#';
      else if (c.box) ch = c.on ? '*' : '$';
      else if (c.hero) ch = c.goal ? '+' : '@';
      else if (c.goal) ch = '.';
      row += ch;
    }
    rows.push(row);
  }
  return rows.join('\n');
}

export function parseSokoban(reply = '') {
  const raw = String(reply ?? '');
  if (RE_QUIT.test(raw)) return { kind: 'quit' };
  if (RE_UNDO.test(raw)) return { kind: 'undo', key: 'U' };
  if (RE_RESTART.test(raw)) return { kind: 'restart', key: 'R' };
  const hit = RE_MARK.exec(raw);
  if (hit) return { kind: 'move', dir: hit[1], key: DIR_KEY[hit[1]] };
  const loose = /(上|下|左|右)/.exec(raw);
  return loose ? { kind: 'move', dir: loose[1], key: DIR_KEY[loose[1]] } : null;
}

export function create() {
  return {
    id: 'sokoban',
    title: '推箱子',
    stepMs: 800,
    maxDecisions: 160,
    maxMinutes: 25,

    async prepare({ browser, progress }) {
      const level = Math.max(1, Math.min(30, Number(progress?.level) || 1));
      await browser.evaluate(`(() => {
        try { if (window.WG && window.WG.setLang) window.WG.setLang('zh'); } catch (e) {}
        const b = document.getElementById('btn-start');
        if (b) b.click();
        if (typeof window.__lv === 'function') window.__lv(${level});
        return 'ok';
      })()`);
      // 切关后它要重排一次布局；等一小会再读，不然读到的是上一关的 DOM。
      await browser.evaluate('new Promise((r) => setTimeout(r, 350)).then(() => "ok")');
    },

    async read({ browser }) {
      const raw = await browser.evaluate(READ_JS);
      let state;
      try { state = JSON.parse(raw); } catch { throw new Error('推箱子状态读不出来'); }
      if (!state?.ready) throw new Error('推箱子还没起来');
      return state;
    },

    board(state) { return boardText(state?.cells, state?.width); },

    prompt({ state, board, progress, leftMs }) {
      const level = Number(state?.level) || Number(progress?.level) || 1;
      const stuck = state?.stuck ? '\n（游戏判断这一局已经死局了：箱子推到了不可能再进目标的位置。可以 [撤] 或 [重来]。）' : '';
      return {
        instructions: [
          '你在玩《推箱子》：把每个箱子（$）推到目标点（.）上，全部推上去就过关。',
          '你只能推、不能拉；箱子推到墙角或两个箱子并排就推不动了，所以先想好顺序。',
          '地图图例：# 墙，. 目标，$ 箱子，* 箱子已经在目标上，@ 你，+ 你在目标上，空格是地板。',
          '一步走一格。只回一行，不要解释：[走:左]（左/右/上/下），或者 [撤]，或者 [不玩了]。',
        ].join('\n'),
        user: `第 ${level}/30 关${leftMs > 0 ? `（时间还够，不用急）` : ''}。\n${board}\n你已经走了 ${Number(state?.moves) || 0} 步、推了 ${Number(state?.pushes) || 0} 下；箱子在目标上 ${Number(state?.boxesOnGoal) || 0}/${Number(state?.boxesTotal) || 0}。${stuck}\n这一手怎么走？`,
        maxTokens: 800,
      };
    },

    parse(reply) { return parseSokoban(reply); },

    async apply({ browser, action }) {
      if (!action?.key) return { ok: false };
      await browser.key(action.key);
      return { ok: true };
    },

    done(state) {
      return state?.solved ? { over: true, victory: true } : { over: false };
    },

    finish({ state, progress, quit }) {
      const level = Number(progress?.level) || Number(state?.level) || 1;
      const solved = Boolean(state?.solved);
      const moves = Number(state?.moves) || 0;
      const pushes = Number(state?.pushes) || 0;
      const got = Number(state?.boxesOnGoal) || 0;
      const total = Number(state?.boxesTotal) || 0;
      const facts = `《推箱子》第 ${level}/30 关，走了 ${moves} 步、推了 ${pushes} 下，箱子在目标上 ${got}/${total}${solved ? '，过了这一关' : quit ? '，不想推了' : '，没推完'}`;
      const nextLevel = solved ? Math.min(30, level + 1) : level;
      return {
        facts,
        victory: solved,
        progress: {
          ...(progress || {}),
          level: nextLevel,
          plays: (Number(progress?.plays) || 0) + 1,
          wins: (Number(progress?.wins) || 0) + (solved ? 1 : 0),
        },
      };
    },
  };
}
