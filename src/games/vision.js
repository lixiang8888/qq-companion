// 看屏兜底：截图 → 看图模型给一步动作 → CDP 执行 → 记下她当时看到什么。
//
// 她只有这一条路玩「没有结构化接口」的游戏。和 PvZ/2048 那种直接读状态的区别是：
// 结构化游戏能报真实分数/关卡；看屏游戏只能报「玩了多久、动了多少下、她当时看到什么」，
// 所以局后感想能引用的材料也只有这些——引不出来就不许编。
//
// 看图模型走 deepseek-flash（和收 QQ 图片同一条路），出站只发截图，不碰她的聊天历史。

export const VISION_DEFAULTS = {
  maxMinutes: 12,
  maxDecisions: 40,
  stepMs: 1500,
};

const KEY_ALIAS = {
  上: 'ArrowUp', 下: 'ArrowDown', 左: 'ArrowLeft', 右: 'ArrowRight',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  space: 'Space', enter: 'Enter', escape: 'Escape', esc: 'Escape',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
};
const KNOWN_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter', 'Escape', 'Tab',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'0123456789']);

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

function normKey(raw = '') {
  const s = String(raw || '').trim();
  const alias = KEY_ALIAS[s.toLowerCase()] || KEY_ALIAS[s] || s;
  return KNOWN_KEYS.has(alias) ? alias : '';
}

/**
 * 从模型回复里抠动作。模型爱写代码围栏、爱多说两句，所以先剥围栏，再找第一个花括号块。
 * 抠不出来返回 null（调用方会让她再截一张、再说一次）。
 */
export function parseVisionAction(reply = '') {
  const raw = String(reply ?? '').replace(/```(?:json)?/gi, '').trim();
  const grab = (text) => {
    try { return JSON.parse(text); } catch { /* 继续尝试 */ }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  };
  const obj = grab(raw);
  if (!obj || typeof obj !== 'object') return null;
  const look = String(obj.look ?? obj.看 ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const a = obj.action ?? obj.动作;
  if (!a || typeof a !== 'object') return null;
  const kind = String(a.kind ?? a.type ?? '').toLowerCase();
  if (kind === 'click') {
    const x = Number(a.x);
    const y = Number(a.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;
    return { look, action: { kind: 'click', x, y } };
  }
  if (kind === 'key') {
    const key = normKey(a.key ?? a.name ?? '');
    return key ? { look, action: { kind: 'key', key } } : null;
  }
  if (kind === 'wait') {
    const ms = Math.max(200, Math.min(10000, Number(a.ms) || 1200));
    return { look, action: { kind: 'wait', ms } };
  }
  if (kind === 'quit') return { look, action: { kind: 'quit' } };
  return null;
}

/** 这一眼要它做什么：把画面、规则和「一次一步」说清。 */
export function visionPrompt({ game = {}, width = 0, height = 0, recent = [] } = {}) {
  const lines = [
    '你在替她玩一个网页小游戏。',
    `游戏：《${game.title}》——${game.summary || '一个小游戏'}`,
    `操作：${game.controls || '看画面决定'}。`,
    `下面这张是当前画面，尺寸 ${width}×${height} 像素（左上角是 0,0）。`,
    '先看一眼，用一句中文说清现在最关键的状态，再决定下一步做什么。',
    '只回一个 JSON，不要代码围栏、不要解释：',
    '{"look":"她现在看到什么（不超过 40 字）","action":{"kind":"click","x":0,"y":0}}',
    'action 只能是这四种：',
    '  {"kind":"click","x":数字,"y":数字}  点画面上的这个坐标',
    '  {"kind":"key","key":"ArrowLeft"}     方向键 / Space / Enter',
    '  {"kind":"wait","ms":1200}            等一会儿再看',
    '  {"kind":"quit"}                      不想玩了',
    '一次只做一步。看不清就先用 wait 等一步，下一张再看。',
  ];
  if (recent.length) lines.push(`前几步看到：${recent.slice(-3).map((x) => String(x).slice(0, 50)).join('；')}`);
  return lines.join('\n');
}

/** 点完这一步之后，她「当时看到的那句话」——局后锚点用。 */
export function actionNote(parsed = {}) {
  const a = parsed?.action;
  if (!a) return '';
  if (a.kind === 'click') return `点了 (${Math.round(a.x)},${Math.round(a.y)})`;
  if (a.kind === 'key') return `按了 ${a.key}`;
  if (a.kind === 'wait') return `等了 ${Math.round(a.ms / 100) / 10} 秒`;
  if (a.kind === 'quit') return '不玩了';
  return '';
}

/**
 * 跑一局看屏游戏。
 * @param {{browser: object, see: Function, now?: Function, sleep?: Function, log?: object,
 *          maxMinutes?: number, maxDecisions?: number, stepMs?: number}} deps
 *   see({dataUrl, prompt}) -> 模型回复文本
 */
export async function runVisionSession(game, {
  browser,
  see,
  progress = {},
  now = Date.now,
  sleep = sleepDefault,
  log = null,
  maxMinutes = VISION_DEFAULTS.maxMinutes,
  maxDecisions = VISION_DEFAULTS.maxDecisions,
  stepMs = VISION_DEFAULTS.stepMs,
} = {}) {
  const t0 = now();
  const deadline = t0 + Math.max(1, Number(maxMinutes) || VISION_DEFAULTS.maxMinutes) * 60e3;
  const cap = Math.max(1, Number(maxDecisions) || VISION_DEFAULTS.maxDecisions);
  const looks = [];
  const actions = [];
  let decisions = 0;
  let clicks = 0;
  let keys = 0;
  let waits = 0;
  let quit = false;
  let done = false;
  let reason = '';

  await browser.evaluate(`(() => {
    try { if (window.WG && window.WG.setLang) window.WG.setLang('zh'); } catch (e) {}
    ${game.start || ''}
    return 'ok';
  })()`);
  await sleep(400);

  const isDone = async () => {
    if (!game.done) return false;
    try { return Boolean(await browser.evaluate(`Boolean(${game.done})`)); } catch { return false; }
  };

  while (decisions < cap && now() < deadline) {
    if (await isDone()) { done = true; reason = 'done'; break; }
    let shot;
    try { shot = await browser.screenshot({ quality: 72 }); } catch (e) {
      log?.warn?.(`《${game.title}》截图失败：${e.message}`);
      reason = 'error';
      break;
    }
    const prompt = visionPrompt({ game, width: shot.width, height: shot.height, recent: looks });
    let parsed = null;
    for (let tries = 0; tries < 2 && !parsed; tries += 1) {
      try {
        const reply = await see({ dataUrl: shot.dataUrl, prompt });
        parsed = parseVisionAction(reply);
      } catch (e) {
        if (tries === 0) { log?.warn?.(`《${game.title}》看一眼失败（${e.message}），再来一次`); continue; }
        log?.warn?.(`《${game.title}》看一眼失败（${e.message}），收摊`);
        reason = 'error';
      }
    }
    if (reason === 'error') break;
    if (!parsed) {
      // 它没按格式回：记下来，算等一步，不把这一步当成玩过。
      decisions += 1;
      actions.push({ at: now(), note: '没看懂这一步', look: '' });
      await sleep(stepMs);
      continue;
    }
    decisions += 1;
    if (parsed.look) looks.push(parsed.look);
    actions.push({ at: now(), note: actionNote(parsed), look: parsed.look });
    const a = parsed.action;
    if (a.kind === 'quit') { quit = true; reason = 'quit'; break; }
    try {
      if (a.kind === 'click') { clicks += 1; await browser.click(a.x, a.y); }
      else if (a.kind === 'key') { keys += 1; await browser.key(a.key); }
      else if (a.kind === 'wait') { waits += 1; await sleep(a.ms); }
    } catch (e) {
      log?.warn?.(`《${game.title}》这一步没做出来：${e.message}`);
    }
    await sleep(stepMs);
  }

  if (!reason) { done = await isDone(); reason = done ? 'done' : 'cap'; }

  // 游戏自己报的数（有的游戏 HUD 上就有），能拿就拿，不硬求。
  let meta = null;
  if (game.read) {
    try { meta = JSON.parse(await browser.evaluate(game.read)); } catch { meta = null; }
  }

  const t1 = now();
  const minutes = Math.max(0, (t1 - t0) / 60e3);
  const bits = [
    `《${game.title}》玩了 ${Math.max(1, Math.round(minutes))} 分钟`,
    `动了 ${clicks + keys} 下（点 ${clicks} 下 / 按 ${keys} 次 / 等 ${waits} 次）`,
  ];
  if (meta && Number(meta.moves) >= 0) bits.push(`游戏记了 ${Number(meta.moves)} 步`);
  bits.push(done ? '这一局玩完了' : quit ? '她自己不想玩了' : '时间到了还没玩完');
  return {
    game: game.id,
    title: game.title,
    at: t1,
    minutes,
    decisions,
    clicks,
    keys,
    waits,
    quit,
    reason,
    victory: Boolean(done),
    facts: bits.join('，'),
    observations: looks,
    actions,
    meta,
    progress: {
      ...(progress || {}),
      plays: (Number(progress?.plays) || 0) + 1,
      wins: (Number(progress?.wins) || 0) + (done ? 1 : 0),
    },
  };
}
