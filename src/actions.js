// 她在回复里留的方括号指令。
//
// 为什么是方括号而不是 tool：我们的会话是自建循环（一次 complete 拿一段文本），
// 不跑 tool。为了「发张图」把整个循环换成 agent loop，多一次往返、多一层协议、
// 多一处会随 DSH 升级而坏的地方——不值。
//
// 协议三个词：`[表情:无语]`、`[查:杭州天气]`、`[书:目录]` / `[书:第12章]`。
// 解析出来之后，标记从文本里剔掉：他看到的应该是话，不是指令。

export const KINDS = ['表情', '查', '书'];
// 全角半角冒号都收；内容最长 40 字，超了就不是指令而是正文。
const MARK = /\[(表情|查|书)\s*[:：]\s*([^\]\n]{1,40})\]/g;
// 她选择这一轮不回，或者过一会儿再回（2026-11-25，用户拍板：直接做）。
// 「晚点回」会落成一条未完成的账，到点由主动通道提醒她——不是把这句吞掉。
const DEFER = /\[(不回|晚点回)\s*(?:[:：]\s*(\d{1,3})(?:\s*分钟)?)?\]/g;
const DEFER_MIN = 5;
const DEFER_MAX = 360;

/**
 * @param {string} text 她这一轮说的话（可能带标记）
 * @returns {{text:string, stickers:string[], searches:string[], books:string[],
 *   silent?:boolean, deferMinutes?:number}}
 */
export function parseActions(text = '') {
  const stickers = [];
  const searches = [];
  const books = [];
  let silent = false;
  let deferMinutes = 0;
  const rest = String(text ?? '')
    .replace(MARK, (_, kind, body) => {
      const value = String(body || '').trim();
      if (value) (kind === '表情' ? stickers : kind === '查' ? searches : books).push(value);
      return '';
    })
    .replace(DEFER, (_, what, mins) => {
      if (what === '不回') { silent = true; return ''; }
      deferMinutes = Math.max(DEFER_MIN, Math.min(DEFER_MAX, Number(mins) || 20));
      return '';
    });
  return {
    text: tidy(rest), stickers, searches, books,
    // 只在真出现时带这两个键：没标记的返回形状和以前完全一样。
    ...(silent ? { silent } : {}),
    ...(deferMinutes ? { deferMinutes } : {}),
  };
}

/**
 * 把标记剔掉之后留下的空档收拾干净：
 * 「不用猜了」「，你继续」这种以标点开头的句子，读起来像手抖。
 */
function tidy(s) {
  return String(s ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[\s，。！？、,.!?~～]+/, '')
    .replace(/[\s]+$/g, '')
    .trim();
}
