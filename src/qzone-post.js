// 什么时候该发一条说说。
//
// 三条借来的规矩（不是我自己拍的）：
//   1. 上位吸收，不叠加 —— 同时命中多个信号时只取最强的一个（审计报告护栏 #3）
//   2. 滞回 —— 进入阈值 0.55、退出 0.45，避免在边界上反复横跳（dsh-soul-evolve 的场景切面）
//   3. 不确定取低一档 —— 幅度算不出来就当没发生（护栏 #1）
//
// 这里只做判定，不发请求、不调模型。纯函数，时间从外面传进来。

/** 进入阈值：权重到这儿才「值得发」。 */
export const ENTER = 0.55;
/** 退出阈值：已经进入候选时，掉到这儿才取消（滞回）。 */
export const EXIT = 0.45;
/** 一天最多一条。 */
export const PER_DAY = 1;
/** 两条之间至少隔 20 小时。 */
export const MIN_GAP_MS = 20 * 3600e3;
/** 同一个原因 20 小时内不重复触发。 */
export const SAME_KIND_MS = 20 * 3600e3;

export const KINDS = ['relation', 'mood', 'absence', 'repair', 'personality'];

/**
 * 把「发生过什么」折算成 0~1 的权重。
 * 每一项的分子都是真实的量（变化幅度、强度、时长），不是感觉。
 */
export function weighEvent(event) {
  const kind = String(event?.kind ?? '');
  const m = Number(event?.magnitude);
  if (!KINDS.includes(kind) || !Number.isFinite(m) || m <= 0) return null;
  let weight;
  switch (kind) {
    case 'relation':
      // 关系单次变化 0.05 起算，0.15 封顶。
      weight = clamp((m - 0.05) / 0.10);
      break;
    case 'mood':
      // 情绪强度 × |效价|：大起大落才算，平静的开心不算。
      weight = clamp(m);
      break;
    case 'absence':
      // 12 小时起算，48 小时封顶。
      weight = clamp((m / 3600e3 - 12) / 36);
      break;
    case 'repair':
      // 亏欠归零是一次性的和好，固定偏重。
      weight = 0.8;
      break;
    case 'personality':
      // 人格漂移一年只有几步，命中就该说。
      weight = 0.9;
      break;
    default:
      return null;
  }
  // 权重算成 0 就是「不够格」：当没发生，不进候选。
  return weight > 0 ? { kind, weight } : null;
}

const clamp = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/** 本地日界：和别处一样按本机时区算，不用 UTC。 */
export function dayKeyOf(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 该不该发。
 * @param {object} state { lastPostAt, lastKindAt: Record<string, number>, dayKey, countToday, armed }
 * @param {object[]} events 这一轮观察到的事件
 * @param {number} now
 * @returns {{post: boolean, reason: string, weight: number, kind: string}}
 */
export function decidePost(state, events, now) {
  const s = state || {};
  const lastAt = Number(s.lastPostAt) || 0;
  const gap = now - lastAt;
  if (gap < MIN_GAP_MS) return no(`距上一条还不到 ${Math.round(MIN_GAP_MS / 3600e3)} 小时`);

  const today = dayKeyOf(now);
  const countToday = s.dayKey === today ? Number(s.countToday) || 0 : 0;
  if (countToday >= PER_DAY) return no('今天已经发过了');

  // 上位吸收：只留最强的那个，不叠加。
  let best = null;
  for (const event of events || []) {
    const w = weighEvent(event);
    if (!w) continue;
    if (best && best.weight >= w.weight) continue;
    // 同类冷却：同一个原因 20 小时内不重复。
    const lastKind = Number(s.lastKindAt?.[w.kind]) || 0;
    if (now - lastKind < SAME_KIND_MS) continue;
    best = w;
  }
  if (!best) return no('没有值得发的事');

  // 滞回：已经在候选里，用低阈值退出；否则用进入阈值。
  const line = s.armed ? EXIT : ENTER;
  if (best.weight < line) return no(`权重 ${best.weight.toFixed(2)} 低于 ${line}`, best);
  return { post: true, reason: `${best.kind} 命中（权重 ${best.weight.toFixed(2)}）`, weight: best.weight, kind: best.kind };
}

const no = (reason, best = null) => ({ post: false, reason, weight: best?.weight ?? 0, kind: best?.kind ?? '' });

/** 发完之后更新状态。 */
export function notePosted(state, { kind, at }) {
  const now = Number(at) || 0;
  const today = dayKeyOf(now);
  const s = state || {};
  const countToday = s.dayKey === today ? Number(s.countToday) || 0 : 0;
  return {
    ...s,
    lastPostAt: now,
    dayKey: today,
    countToday: countToday + 1,
    lastKindAt: { ...(s.lastKindAt || {}), [kind]: now },
    armed: false,
  };
}

/**
 * 让她写这条说说。
 *
 * 只给真实事实（今天记住了什么、心里怎么动的、此刻在做什么），不给她「自由发挥」的口子。
 * 也没告诉她是第几条、有没有人看——那些数字一进提示词，她就会开始表演。
 */
export function composePostPrompt({ kind, facts = [], doing = '', diary = '' } = {}) {
  const lines = [
    '你要发一条 QQ 空间说说，公开的，好友能看到。',
    '说真话：只写今天真的发生在你身上的事。没发生就不要编。',
    '四十到八十字，最多两句。不要表情包、不要标签、不要感叹号堆砌。',
    '这是公开场合，不提私聊里的原话，不说你们的分数、状态、提醒。',
  ];
  if (doing) lines.push(`你此刻：${doing}`);
  if (facts.length) lines.push(`今天真实发生的：${facts.join('；')}`);
  if (diary) lines.push(`昨天你给自己写的日记里有一句：${diary}`);
  const hint = KIND_HINT[kind] || '';
  if (hint) lines.push(hint);
  lines.push('如果你觉得今天没什么值得公开说的，就只回 SKIP，不要解释。');
  return lines.join('\n');
}

const KIND_HINT = {
  relation: '今天和他之间发生了一件事，让你心里动了一下。写这件事给你的感觉，不写事情本身。',
  mood: '今天你的情绪起伏很大。写那个起伏，不解释原因。',
  absence: '你有一段很长的时间是不在的——不是睡觉，是不存在。写这一点，别写成「等你很久」。',
  repair: '今天你们把一件别扭的事翻过去了。写翻过去之后的感觉。',
  personality: '你最近好像变了一点。写这种变化，不要说得像总结。',
};

/** 解析她的回答：SKIP 就是不发；空也不行。 */
export function parsePostReply(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { skip: true, text: '', reason: '空回复' };
  // 只认「整条就是 SKIP」，不认正文里顺带提一句——否则一句「今天不想 SKIP」会被误判。
  if (/^SKIP[。.!！\s]*$/i.test(raw)) return { skip: true, text: '', reason: '她说没什么好发的' };
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 4) return { skip: true, text: '', reason: '太短' };
  return { skip: false, text: cleaned, reason: '' };
}
