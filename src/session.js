// 会话层：自己管对话历史，自己决定什么时候压缩。
//
// 为什么不让 DSH 管：陪伴体需要「记得住最近、老的压成一句」这条线由自己掌握——
// 什么时候压、压掉什么、压完还留哪些，都会影响她说的话像不像同一个人。
// 这里只依赖一个 complete({system, messages}) → string 的注入点，方便离线测。

const SUMMARY_MAX_CHARS = 1200;
const SYSTEM_SUFFIX = '你正在和一个特定的人私下聊天。状态只影响语气，不要说出来。';

// 记忆使用协议（dsh-memory-core 的五条，MIT）：不写进人格，写在系统提示末尾，
// 因为它约束的是「怎么用记忆」而不是「你是谁」。
const MEMORY_PROTOCOL = `【关于记忆的规矩】
1. 记忆里的事是过去发生的，不是他这一轮刚说的。
2. 记忆可能过期或记错，拿不准就说记不清。
3. 提到旧事要能说出是什么时候的；说不出来就别装。
4. 新说法和旧记忆冲突时，以新的为准。
5. 不要编造记忆里没有的细节，也不要用记忆去邀功。`;

export function createLocalSession({
  complete,                 // async ({system, messages, maxTokens, temperature}) => string
  system = '',
  compactAt = 30,           // 超过这么多条（user+assistant）就压
  keepRecent = 12,          // 压缩时保留最近这么多条原文
  summaryMaxTokens = 400,
  now = Date.now,
  initial = null,           // 上次落盘的状态：{summary, history, compactions}
  persist = null,           // (snapshot) => void，每轮之后调用
} = {}) {
  if (typeof complete !== 'function') throw new Error('createLocalSession 需要 complete()');

  /** @type {{role:'user'|'assistant',text:string,at:number}[]} */
  let history = Array.isArray(initial?.history) ? initial.history.slice(-keepRecent * 2) : [];
  let summary = typeof initial?.summary === 'string' ? initial.summary : '';
  let compactions = Number(initial?.compactions) || 0;
  // 压缩为什么失败：以前这里 catch 完什么都不留，结果 84 条历史、0 次压缩，谁也不知道发生了什么。
  let lastError = initial?.lastError || null;
  // 压不动、丢了老记录时的那句说明。单独放，不和真摘要混在一起：
  // 真摘要用「摘要」标签，丢档说明用「更早的对话」标签。
  let droppedNote = '';

  const systemOf = (context = '') => [typeof system === 'function' ? system() : system, SYSTEM_SUFFIX, MEMORY_PROTOCOL, summary ? `【更早的对话摘要】${summary}` : '', droppedNote ? `【更早的对话】${droppedNote}` : '', context]
    .filter(Boolean).join('\n\n');

  async function compact() {
    const head = history.slice(0, history.length - keepRecent);
    if (!head.length) return false;
    const transcript = head.map((m) => `${m.role === 'user' ? '他' : '我'}：${m.text}`).join('\n');
    let next = '';
    try {
      // 不要传 temperature：有些推理模型会直接拒绝这个参数，而主对话（不传）是好的——
      // 结果就是「聊天正常、压缩每次都失败」，且失败被静默吞掉。
      next = await complete({
        system: '把下面这段对话压成一段摘要，给之后的自己看：保留关系变化、约定、他在意的事、没说完的话题；不要评价、不要编。不超过 200 字。',
        messages: [{ role: 'user', text: transcript }],
        maxTokens: summaryMaxTokens,
      });
    } catch (error) {
      // 压缩失败不能丢历史：保留原文继续跑，下次再试。但原因必须留下来。
      lastError = { at: now(), message: String(error?.message || error) };
      return false;
    }
    const text = String(next || '').trim();
    if (!text) {
      lastError = { at: now(), message: '压缩返回空内容' };
      return false;
    }
    summary = await capSummary(summary ? `${summary}\n${text}` : text);
    history = history.slice(-keepRecent);
    compactions += 1;
    try { persist?.({ summary, history: history.slice(), compactions }); } catch { /* 落盘失败不影响继续 */ }
    return true;
  }

  const snapshot = () => ({ summary: [summary, droppedNote].filter(Boolean).join('\n'), history: history.slice(), compactions, lastError });
  const save = () => { try { persist?.(snapshot()); } catch { /* 落盘失败不能让这一轮回不去 */ } };

  /**
   * 兜底：压缩连续失败时，历史会只涨不跌（每轮都为全部历史付费）。
   * 到 compactAt×3 还压不动，就丢掉最老的部分保命——有损，但不会让她一直背着全部记录。
   */
  function dropOldest() {
    const dropped = history.length - keepRecent;
    if (dropped <= 0) return false;
    history = history.slice(-keepRecent);
    droppedNote = '（更早的一部分对话没压住，丢了）';
    compactions += 1;
    lastError = { at: now(), message: `压缩失败，已丢弃最老的 ${dropped} 条` };
    return true;
  }

  /** 摘要不能无限长：超过上限就再压一次，压不动就截尾兜底。 */
  async function capSummary(text) {
    if (text.length <= SUMMARY_MAX_CHARS) return text;
    try {
      const squeezed = await complete({
        system: '把下面这段对话摘要再压一次，保留关系变化、约定、他在意的事、没说完的话题；不要评价、不要编。不超过 400 字。',
        messages: [{ role: 'user', text }],
        maxTokens: summaryMaxTokens,
      });
      const t = String(squeezed || '').trim();
      if (t) return t.length > SUMMARY_MAX_CHARS ? t.slice(-SUMMARY_MAX_CHARS) : t;
    } catch { /* 压不动就走截断 */ }
    return text.slice(-SUMMARY_MAX_CHARS);
  }

  return {
    async prompt(chatId, text, { context = '' } = {}) {
      history.push({ role: 'user', text: String(text), at: now() });
      if (history.length > compactAt) {
        const ok = await compact();
        // 压不动就别硬扛：历史涨到三倍阈值还失败，丢老的保命。
        if (!ok && history.length > compactAt * 3) dropOldest();
      }

      const reply = await complete({
        system: systemOf(context),
        messages: history.map(({ role, text }) => ({ role, text })),
      });
      const clean = String(reply ?? '').trim();
      // 空回复（被过滤、被掐断）不要写进历史：下一轮模型会看见一条空的「她说过的话」，
      // 只会让她更不会说话。留白就留白，由上层决定发不发。
      if (clean) history.push({ role: 'assistant', text: clean, at: now() });
      save();
      return clean;
    },

    /** 面板/调试用。 */
    snapshot,

    get size() { return history.length; },
  };
}
