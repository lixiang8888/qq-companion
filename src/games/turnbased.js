// 结构化游戏的公共回合循环：
//   收阳光/暂停 → 读真实状态 → 她决定 → 落一手 → 等一会 → 再暂停
//
// 每款游戏只写自己特有的事（src/games/<id>.js 的驱动规格）；这里负责：
// 上限、重试、暂停/继续的配对、把「这一手没落下去」记下来给局后材料用。
// 浏览器是注入的，所以这一层能离线测。

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑一局结构化游戏。
 * @param {object} spec 驱动规格，见 docs/superpowers/plans/2026-11-26-games-platform.md
 * @param {{browser: object, ask: Function, progress?: object, now?: Function, sleep?: Function, log?: object}} deps
 */
export async function runStructuredSession(spec, {
  browser,
  ask,
  progress = {},
  now = Date.now,
  sleep = sleepDefault,
  log = null,
} = {}) {
  if (!spec?.id) throw new Error('结构化游戏缺驱动');
  const t0 = now();
  const maxDecisions = Math.max(1, Number(spec.maxDecisions) || 120);
  const maxMinutes = Math.max(1, Number(spec.maxMinutes) || 30);
  const deadline = t0 + maxMinutes * 60e3;
  const notes = [];
  const turns = [];
  let state = null;
  let decisions = 0;
  let quit = false;
  let reason = '';

  await spec.prepare?.({ browser, progress, log });

  try {
    while (decisions < maxDecisions && now() < deadline) {
      await spec.beforeTurn?.({ browser });
      if (spec.pause) await spec.pause({ browser, on: true });
      state = await spec.read({ browser });
      const end = spec.done?.(state, { progress }) || {};
      if (end.over) { reason = end.victory ? 'victory' : 'over'; break; }

      const prompt = spec.prompt({
        state,
        board: spec.board ? spec.board(state) : '',
        progress,
        leftMs: deadline - now(),
      });
      let reply = '';
      for (let tries = 0; tries < 2 && !reply; tries += 1) {
        try {
          reply = String(await ask(prompt) || '').trim();
        } catch (e) {
          if (tries === 0) { log?.warn?.(`《${spec.title}》这一手想不出来（${e.message}），再问一次`); continue; }
          notes.push('想不出这一手，收摊');
          log?.warn?.(`《${spec.title}》想不出这一手（${e.message}），收摊`);
          reason = 'error';
        }
      }
      if (reason === 'error') break;
      if (!reply) {
        decisions += 1;
        notes.push('空回复，算等一手');
        await sleep(Number(spec.stepMs) || 1000);
        continue;
      }

      decisions += 1;
      const action = spec.parse ? spec.parse(reply, { state, progress }) : null;
      if (action?.kind === 'quit') { quit = true; reason = 'quit'; break; }
      if (spec.pause) await spec.pause({ browser, on: false });
      if (action && action.kind !== 'wait') {
        try {
          const r = await spec.apply({ browser, action, progress, state });
          if (r?.note) notes.push(r.note);
        } catch (e) {
          notes.push(`这一手没落下去：${e.message}`);
          log?.warn?.(`《${spec.title}》落子失败：${e.message}`);
        }
      }
      turns.push({ at: now(), reply, action });
      await sleep(Number(spec.stepMs) || 1000);
    }
  } finally {
    // 不管怎么结束，最后读一次真实状态（她要说的话得对得上这一局的结尾）。
    try { state = await spec.read({ browser }); } catch { /* 读不到就用上一次的 */ }
  }

  if (!reason) reason = quit ? 'quit' : 'cap';
  const t1 = now();
  const minutes = Math.max(0, (t1 - t0) / 60e3);
  const out = spec.finish
    ? spec.finish({ state, progress, decisions, quit, reason, notes, turns, t0, t1, minutes })
    : { facts: '', progress: null, victory: false };
  return {
    ...out,
    game: spec.id,
    title: spec.title,
    at: t1,
    minutes,
    decisions,
    quit,
    reason,
    notes,
    victory: Boolean(out?.victory),
  };
}
