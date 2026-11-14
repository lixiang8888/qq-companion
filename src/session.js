// 会话层：自己管对话历史，自己决定什么时候压缩。
//
// 为什么不让 DSH 管：陪伴体需要「记得住最近、老的压成一句」这条线由自己掌握——
// 什么时候压、压掉什么、压完还留哪些，都会影响她说的话像不像同一个人。
// 这里只依赖一个 complete({system, messages}) → string 的注入点，方便离线测。

const SUMMARY_MAX_CHARS = 1200;
const SYSTEM_SUFFIX = '你正在和一个特定的人私下聊天。状态只影响语气，不要说出来。';
// 断层阈值：隔了半小时以上才值得标一次时间。每句都标既贵又像日志。
const GAP_MS = 30 * 60e3;
// 一轮最多带几张原图。截图/表情包常常三连发，全带上就是几百上千 token 白花。
export const MAX_TURN_IMAGES = 2;

/**
 * 一句话说的时刻，相对「现在」现算。
 * 现算而不是存下来：昨天打的「今天」今天就成了假话。
 */
export function stampOf(at, now = 0) {
  const d = new Date(Number(at) || Number(now));
  const n = new Date(Number(now) || Date.now());
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(n) - midnight(d)) / 864e5);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (days <= 0) return `今天 ${hm}`;
  if (days === 1) return `昨天 ${hm}`;
  if (days === 2) return `前天 ${hm}`;
  if (days < 7) return `${days} 天前 ${hm}`;
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

/**
 * 给历史打时间戳：只在断层处打——第一条，以及和上一条隔了半小时以上的那条。
 *
 * 为什么必须有这一步：以前 history 存了 at，拼 messages 时却只取 {role,text}，
 * 于是「前天晚上他嫌我不主动」和「刚才他发了两个么么」在她眼里是紧挨着的两句，
 * 她把两天前的事说成了「刚刚」。
 */
export function withStamps(history = [], now = 0, { gapMs = GAP_MS } = {}) {
  let prev = 0;
  return (history || []).map((m) => {
    const at = Number(m?.at) || 0;
    const need = !prev || !at || at - prev > gapMs;
    if (at) prev = at;
    const text = String(m?.text ?? '');
    return { role: m?.role, text: need ? `（${stampOf(at || now, now)}）${text}` : text };
  });
}

// 记忆使用协议（dsh-memory-core 的五条，MIT，见 THIRD_PARTY_NOTICES.md）：不写进人格，写在系统提示末尾，
// 因为它约束的是「怎么用记忆」而不是「你是谁」。
const MEMORY_PROTOCOL = `【关于记忆的规矩】
1. 记忆里的事是过去发生的，不是他这一轮刚说的。
2. 记忆可能过期或记错，拿不准就说记不清。
3. 提到旧事要能说出是什么时候的；说不出来就别装。
4. 新说法和旧记忆冲突时，以新的为准。
5. 不要编造记忆里没有的细节，也不要用记忆去邀功。
6. 记忆是碎片，不是账本：能引用原话就引用（「你说过『等我练出八块腹肌』」）。
   有碎片但没下结论，不等于「完全记不清」，这是两件事——别把前者说成后者。
7. 原话里的「她」「那个」「这个」不一定还指得上眼前的事。能引原话，但别替它补主语：
   想不起当时说的是谁、在说什么，就说想不起——补上去的那个猜测，比记不清糟糕得多。`;

// 加这一条是因为她真的错过：前天晚上的抱怨，她第二天说成「刚还嫌我不理你」。
const TIME_NOTE = `【关于时间】
对话里某句前面带括号（比如「（昨天 21:44）」）的，那是那句话说的时刻；不带括号的就是紧接着上一句。
说「刚刚」「今天」「昨天」之前先看那个括号——别把前天的事说成刚发生。`;

/**
 * 压缩之后留多少条原文。
 *
 * 按时间算，不按条数算：他一个晚上聊四十句，条数阈值当晚就满，整晚的原文被压成一句摘要——
 * 而「记得住最近这一阵」正是她最该有的东西。所以先问「这些话有多老」，
 * 老过 keepHours 才值得压；上限 maxRecent 是防跑飞的硬闸。
 *
 * keepHours = 0 表示不看时间，只按条数（老行为）。
 */
export function recentCount(history = [], now = 0, { keepHours = 0, keepRecent = 16, maxRecent = 0 } = {}) {
  if (!keepHours) {
    let keep = keepRecent;
    if (maxRecent) keep = Math.min(maxRecent, keep);
    return keep;
  }
  const cut = Number(now) - keepHours * 3600e3;
  let n = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if ((Number(history[i]?.at) || 0) < cut) break;
    n += 1;
  }
  let keep = Math.max(keepRecent, n);
  if (maxRecent) keep = Math.min(maxRecent, keep);
  return keep;
}

export function createLocalSession({
  complete,                 // async ({system, messages, maxTokens, temperature}) => string
  system = '',
  compactAt = 40,           // 超过这么多条（user+assistant）才考虑压
  keepRecent = 16,          // 至少保留最近这么多条原文
  keepHours = 0,            // 比这更年轻的原文不压（0 = 不看时间，只按条数）
  maxRecent = 0,            // 原文条数硬上限（0 = 不设）
  // 400 不够：推理模型先用思考占掉一截，正文就空了（真机上确实空过）。
  summaryMaxTokens = 800,
  now = Date.now,
  initial = null,           // 上次落盘的状态：{summary, history, compactions}
  persist = null,           // (snapshot) => void，每轮之后调用
  onMessage = null,         // ({role,text,at}) => void，每条真的进历史的话都记一笔（归档用）
} = {}) {
  if (typeof complete !== 'function') throw new Error('createLocalSession 需要 complete()');

  /** @type {{role:'user'|'assistant',text:string,at:number}[]} */
  let history = Array.isArray(initial?.history) ? initial.history.slice(-(maxRecent || keepRecent * 2)) : [];
  let summary = typeof initial?.summary === 'string' ? initial.summary : '';
  let compactions = Number(initial?.compactions) || 0;
  // 压缩为什么失败：以前这里 catch 完什么都不留，结果 84 条历史、0 次压缩，谁也不知道发生了什么。
  let lastError = initial?.lastError || null;
  // 压不动、丢了老记录时的那句说明。单独放，不和真摘要混在一起：
  // 真摘要用「摘要」标签，丢档说明用「更早的对话」标签。
  let droppedNote = '';

  const systemOf = (context = '') => [typeof system === 'function' ? system() : system, SYSTEM_SUFFIX, MEMORY_PROTOCOL, TIME_NOTE, summary ? `【更早的对话摘要】${summary}` : '', droppedNote ? `【更早的对话】${droppedNote}` : '', context]
    .filter(Boolean).join('\n\n');

  async function compact() {
    const keep = recentCount(history, now(), { keepHours, keepRecent, maxRecent });
    const head = history.slice(0, history.length - keep);
    if (!head.length) return false;
    // 压缩的入参也带时间戳：不带的话，压完这三次之后的旧事就再也没有年龄了。
    const transcript = withStamps(head, now()).map((m) => `${m.role === 'user' ? '他' : '我'}：${m.text}`).join('\n');
    let next = '';
    try {
      // 不要传 temperature：有些推理模型会直接拒绝这个参数，而主对话（不传）是好的——
      // 结果就是「聊天正常、压缩每次都失败」，且失败被静默吞掉。
      next = await complete({
        system: '把下面这段对话压成一段摘要，给之后的自己看：保留关系变化、约定、他在意的事、没说完的话题，以及每件事大概是什么时候（今天/昨天/几号）；不要评价、不要编。不超过 200 字。',
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
    history = history.slice(-keep);
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
    const keep = recentCount(history, now(), { keepHours, keepRecent, maxRecent });
    const dropped = history.length - keep;
    if (dropped <= 0) return false;
    history = history.slice(-keep);
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
        system: '把下面这段对话摘要再压一次，保留关系变化、约定、他在意的事、没说完的话题，以及每件事大概是什么时候；不要评价、不要编。不超过 400 字。',
        messages: [{ role: 'user', text }],
        maxTokens: summaryMaxTokens,
      });
      const t = String(squeezed || '').trim();
      if (t) return t.length > SUMMARY_MAX_CHARS ? t.slice(-SUMMARY_MAX_CHARS) : t;
    } catch { /* 压不动就走截断 */ }
    return text.slice(-SUMMARY_MAX_CHARS);
  }

  return {
    /**
     * @param {string[]} [opts.images] 这一轮真的给她看的图（data URL）。
     *   只贴在最后一条上：她当场看见原图，之后回想的仍是历史里那段文字描述——
     *   图片字节不进历史，因为签名链接会过期、字节会把 session.json 撑爆。
     */
    async prompt(chatId, text, { context = '', images = [] } = {}) {
      const at = now();
      history.push({ role: 'user', text: String(text), at });
      // 归档在压缩之前：压缩会把原文吃掉，而这里正是原文还在的那一瞬。
      try { onMessage?.({ role: 'user', text: String(text), at }); } catch { /* 归档失败不影响回话 */ }
      if (history.length > compactAt) {
        // 条数够了也要看年龄：比 keepHours 更年轻的一句都不压。
        // 不这样的话，一个晚上聊四十句，当晚就把整晚原文压成一句摘要。
        const tooOld = !keepHours || (Number(history[0]?.at) || 0) < at - keepHours * 3600e3;
        const overCap = maxRecent > 0 && history.length > maxRecent;
        if (tooOld || overCap) {
          const ok = await compact();
          // 压不动就别硬扛：历史涨到三倍阈值还失败，丢老的保命。
          if (!ok && history.length > compactAt * 3) dropOldest();
        }
      }

      const msgs = withStamps(history, now());
      const shown = (Array.isArray(images) ? images : []).filter(Boolean).slice(0, MAX_TURN_IMAGES);
      if (shown.length && msgs.length) {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], images: shown };
      }

      let reply;
      try {
        reply = await complete({
          system: systemOf(context),
          messages: msgs,
        });
      } catch (error) {
        // 换了个不收图片的模型时，不能因为她看不了图就整轮哑掉：
        // 去掉图、只留文字再试一次。这一条比「看见原图」重要得多。
        if (!shown.length) throw error;
        reply = await complete({
          system: systemOf(context),
          messages: msgs.map(({ images, ...rest }) => rest),
        });
      }
      const clean = String(reply ?? '').trim();
      // 空回复（被过滤、被掐断）不要写进历史：下一轮模型会看见一条空的「她说过的话」，
      // 只会让她更不会说话。留白就留白，由上层决定发不发。
      if (clean) {
        const at2 = now();
        history.push({ role: 'assistant', text: clean, at: at2 });
        try { onMessage?.({ role: 'assistant', text: clean, at: at2 }); } catch { /* 归档失败不影响回话 */ }
      }
      save();
      return clean;
    },

    /**
     * 同一轮里再要一次回复：她在上一版里写了 `[查:…]`，我们去查了，把材料补进 context 再问一遍。
     *
     * 第一版的回复作废——它被第二轮取代了。留着的话，她下一轮会看见自己说过两遍同一句话，
     * 而且第一遍里还带着没兑现的方括号。
     */
    async retry(context = '') {
      const msgs = withStamps(history, now());
      const reply = await complete({ system: systemOf(context), messages: msgs });
      const clean = String(reply ?? '').trim();
      if (clean) {
        const at = now();
        if (history.at(-1)?.role === 'assistant') history[history.length - 1] = { role: 'assistant', text: clean, at };
        else history.push({ role: 'assistant', text: clean, at });
        try { onMessage?.({ role: 'assistant', text: clean, at }); } catch { /* 归档失败不影响回话 */ }
      }
      save();
      return clean;
    },

    /**
     * 记一句「她真的发出去过的话」，但不叫模型。
     * 主动搭话走的是独立调用，不经过这里；可她确实对他说了那句话，
     * 不记下来的话，他下一句接上时她会完全不知道自己刚说过什么。
     */
    note(text, { role = 'assistant', at = now() } = {}) {
      const clean = String(text ?? '').trim();
      if (!clean) return false;
      history.push({ role, text: clean, at });
      try { onMessage?.({ role, text: clean, at }); } catch { /* 归档失败不影响回话 */ }
      save();
      return true;
    },

    /** 面板/调试用。 */
    snapshot,

    get size() { return history.length; },
  };
}


