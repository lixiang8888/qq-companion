// 她在回复里留的方括号指令。
//
// 为什么是方括号而不是 tool：我们的会话是自建循环（一次 complete 拿一段文本），
// 不跑 tool。为了「发张图」把整个循环换成 agent loop，多一次往返、多一层协议、
// 多一处会随 DSH 升级而坏的地方——不值。
//
// 协议只有两个词：`[表情:无语]`、`[查:杭州天气]`。
// 解析出来之后，标记从文本里剔掉：他看到的应该是话，不是指令。

export const KINDS = ['表情', '查'];
// 全角半角冒号都收；内容最长 40 字，超了就不是指令而是正文。
const MARK = /\[(表情|查)\s*[:：]\s*([^\]\n]{1,40})\]/g;

/**
 * @param {string} text 她这一轮说的话（可能带标记）
 * @returns {{text:string, stickers:string[], searches:string[]}}
 */
export function parseActions(text = '') {
  const stickers = [];
  const searches = [];
  const rest = String(text ?? '').replace(MARK, (_, kind, body) => {
    const value = String(body || '').trim();
    if (value) (kind === '表情' ? stickers : searches).push(value);
    return '';
  });
  return { text: tidy(rest), stickers, searches };
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

/** 文本里还有没有指令（用来判断「这一轮要不要重来一次」）。 */
export const hasSearch = (text) => parseActions(text).searches.length > 0;
