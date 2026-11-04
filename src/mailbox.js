// 连发合并：他连着打三条，她只该想一次。
//
// 窗口从**最后一条**消息算起：每条新消息把 3 秒重新点一次，安静下来才开一轮。
// 为什么不是每条都回：一次「在吗 / 睡了吗 / 我跟你说个事」是**一个念头**，
// 分三次回既不像人，也多烧三次模型调用。
//
// 只做攒和发，不认识消息里的内容，所以可以离线测。

export const DEFAULT_WINDOW_MS = 3000;
// 合并后的文本上限：跟单条入站一致。超了留最近的——他刚说的话才是要回答的。
export const MAX_MERGED_CHARS = 4000;

export function mergeTexts(texts, max = MAX_MERGED_CHARS) {
  const joined = (texts || []).map((t) => String(t ?? '')).join('\n');
  if (joined.length <= max) return joined;
  return `（前面太长，没看完）\n${joined.slice(-max)}`;
}

/**
 * @param {object} o
 * @param {number} [o.windowMs] 安静窗口；0 = 不合并（每条立刻一轮）
 * @param {(fn: Function, ms: number) => any} [o.later] 注入的调度器
 * @param {(h: any) => void} [o.clear]
 * @param {(batch: {chatId: string, userId: string, texts: string[], last: object}) => any} [o.onFlush]
 */
export function createMailbox({ windowMs = DEFAULT_WINDOW_MS, later = (fn, ms) => setTimeout(fn, ms), clear = (h) => clearTimeout(h), onFlush = () => {} } = {}) {
  let timer = null;
  let batch = null;

  const stopTimer = () => {
    if (timer !== null) {
      clear(timer);
      timer = null;
    }
  };

  function flush() {
    stopTimer();
    const b = batch;
    batch = null;
    if (!b) return undefined;
    const result = onFlush({ chatId: b.chatId, userId: b.userId, texts: b.texts.slice(), last: b.last });
    for (const resolve of b.waiters) resolve(result);
    return result;
  }

  function push(msg) {
    // 换了聊天对象：旧的那批先发出去，不能把两段对话混成一轮。
    if (batch && batch.chatId !== msg.chatId) flush();
    if (!batch) batch = { chatId: msg.chatId, userId: msg.userId, texts: [], waiters: [], last: msg };
    batch.texts.push(String(msg.text ?? ''));
    batch.last = msg;
    const done = new Promise((resolve) => batch.waiters.push(resolve));
    if (windowMs <= 0) {
      flush();
      return done;
    }
    stopTimer();
    timer = later(flush, windowMs);
    return done;
  }

  return {
    push,
    flush,
    get pending() { return batch ? batch.texts.length : 0; },
  };
}
