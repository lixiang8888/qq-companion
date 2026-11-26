// 她的世界在这一刻有没有变化。
//
// 为什么需要这一步：以前所有传感器（屏幕、天气、图片、记忆）都是在**他说话那一刻**
// 才去取的——`contextBlock` 整条链挂在回复路径上。所以他不吭声的时候她的世界是冻住的，
// 她能说的只有他刚说的那句。这里把「外面真的变了什么」抽成事件，喂给她自己想的那一次调用。
//
// 纯函数：只收状态、不读盘、不调模型。事件文本会进系统提示，所以每个字段都截断（信任边界）。

export const MAX_EVENTS = 6;
// 他多久没吭声才值得当成一件事：六小时。再短就成了催。
export const SILENCE_MS = 6 * 3600e3;
// 天气超过这么久没更新才提醒一次。
export const WEATHER_STALE_MS = 12 * 3600e3;
// 只在早上提醒看天气。半夜提醒没有意义。
export const WEATHER_HOURS = [6, 10];
// 图超过一天就不算「刚才」。
export const PICTURE_MS = 24 * 3600e3;
// 书是六小时内还在看才算「刚在看」；念头活得久一点（36 小时），和注入那边一致。
export const NOVEL_MS = 6 * 3600e3;
export const THOUGHT_MS = 36 * 3600e3;
// 游戏这一局比书耐放：打完一局，六小时内都算「刚打完」，可以拿来开头。
export const GAME_MS = 6 * 3600e3;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export const startOfDay = (ms) => {
  const d = new Date(num(ms));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** 一段时长说成人话：3 小时 / 25 分钟。 */
export function gapWords(ms) {
  const gap = Math.max(0, num(ms));
  if (gap >= 3600e3) return `${Math.round(gap / 3600e3)} 小时`;
  return `${Math.max(1, Math.round(gap / 60e3))} 分钟`;
}

/**
 * @param {object} state 全部来自本机上已经落盘的真事
 * @param {number} [state.now]
 * @param {boolean} [state.screenOn] 屏幕感知开着没
 * @param {{at?:number,title?:string}} [state.screen]
 * @param {boolean} [state.weatherOn]
 * @param {{at?:number}} [state.weather]
 * @param {number} [state.lastUserAt] 他最后说话的时刻
 * @param {string[]} [state.pending] 没问完的话
 * @param {{records?:object[]}} [state.memory] 记忆卡
 * @param {number|null} [state.balance] 账户余额（拿不到就是 null）
 * @param {number} [state.lowBalance] 低于这个数要提一次
 * @param {{doing?:string,until?:number}} [state.life]
 * @param {number} [state.lastPictureAt] 最近一张他发的图
 * @param {object} [state.seen] 上次已经报过的事（去重用）
 * @returns {{events:{kind:string,text:string}[], seen:object}}
 */
export function perceive(state = {}) {
  const now = num(state.now);
  const seen = { ...(state.seen || {}) };
  const events = [];
  const add = (kind, text) => { const t = clip(text, 80); if (t) events.push({ kind, text: t }); };

  // 他屏幕上换了东西。窗口标题一条就够了——她说「你在看那个报错吧」比说「你在忙」像是真的在场。
  const title = clip(state.screen?.title, 40);
  if (state.screenOn === true && title && title !== seen.screenTitle) {
    seen.screenTitle = title;
    add('screen', `他那边屏幕上现在是「${title}」`);
  }

  // 天气该重新看了：只在早上提，而且真的过期了才提。
  const wAt = num(state.weather?.at);
  const hour = new Date(now).getHours();
  if (state.weatherOn === true && wAt && now - wAt > WEATHER_STALE_MS
    && hour >= WEATHER_HOURS[0] && hour < WEATHER_HOURS[1]) {
    add('weather', `你上次看外面天气是 ${gapWords(now - wAt)}前了`);
  }

  // 他很久没说话了。
  const lastUserAt = num(state.lastUserAt);
  if (lastUserAt && now - lastUserAt >= SILENCE_MS) {
    add('silence', `他已经 ${gapWords(now - lastUserAt)}没跟你说话了`);
  }

  // 还有一句没问完。
  const pending = (state.pending || []).filter(Boolean);
  if (pending.length) add('unfinished', `你心里还挂着一句没问完的：「${clip(pending[0], 40)}」`);

  // 今天多记住了几件事：数字变了才算新事，别每十分钟重复一遍同一个数。
  const fresh = (state.memory?.records || []).filter((r) => num(r?.createdAt) >= startOfDay(now)).length;
  if (fresh > 0 && fresh !== seen.memoryCount) {
    seen.memoryCount = fresh;
    add('memory', `今天你多记住了 ${fresh} 件事`);
  }

  // 家里钱不多了：只提一次，别每个周期报一次账。
  const total = num(state.balance);
  if (state.balance !== null && state.balance !== undefined
    && num(state.lowBalance) > 0 && total < num(state.lowBalance) && seen.moneyLow !== true) {
    seen.moneyLow = true;
    add('money', `家里只剩 ${total.toFixed(2)} 元`);
  }

  // 她刚才在干的事到点了。
  const doing = clip(state.life?.doing, 40);
  const until = num(state.life?.until);
  if (doing && until && until <= now) add('doing', `你刚才在${doing}，这会儿做完了`);

  // 他刚发过一张图：同一张只说一次。
  const picAt = num(state.lastPictureAt);
  if (picAt && now - picAt <= PICTURE_MS && picAt !== seen.pictureAt) {
    seen.pictureAt = picAt;
    add('picture', `${gapWords(now - picAt)}前他给你发过一张图`);
  }

  // 她自己看的书：这是她的生活，不是他给的话题——他安静的时候她有权利说「我刚在看…」。
  const nv = state.novel || {};
  const nvAt = num(nv.at);
  if (nvAt && nv.bookName && now - nvAt <= NOVEL_MS && nvAt !== seen.novelAt) {
    seen.novelAt = nvAt;
    const label = clip(nv.label, 4);
    const title = clip(nv.title, 20);
    add('novel', `你刚在看《${clip(nv.bookName, 20)}》${title ? ` ${title}` : ''}${label ? `，${label}` : ''}`);
  }
  // 这两天她自己想出来的那句话：也是真事（她想的，不是他说的），可以拿来开头。
  const thought = (nv.thoughts || []).filter((x) => num(x?.at) >= now - THOUGHT_MS).pop();
  if (thought && num(thought.at) !== seen.thoughtAt) {
    seen.thoughtAt = num(thought.at);
    add('thought', `你这两天自己在想：「${clip(thought.text, 40)}」`);
  }

  // 她自己玩的一局游戏：跟书一样是她自己的生活，不是他给的话题。材料是这一局的真实记录。
  const gm = state.game?.last;
  const gmAt = num(gm?.at);
  if (gmAt && gm?.facts && now - gmAt <= GAME_MS && gmAt !== seen.gameAt) {
    seen.gameAt = gmAt;
    add('game', `你刚玩完一局《${clip(gm.title || gm.game, 20)}》：${clip(gm.facts, 80)}${gm.label ? `，${gm.label}` : ''}`);
  }

  return { events: events.slice(0, MAX_EVENTS), seen };
}
