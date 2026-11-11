// 把四层状态拼成每轮注入的上下文。
//
// 三条约束（手册 §4.1）：只影响语用层（句长、语气词、接梗、自我披露），
// 不动命题内容（事实、数字、承诺、对他的评价、建议内容）；
// 状态不许说出口，也不许解释自己为什么这样说话。
//
// 文本要短且顺序固定：它每轮都在 prompt 尾部，变长等于每轮多付 token。

import { driftLine, traitLine } from './personality.js';

export function moodLabel(v) {
  if (v >= 0.7) return '不错';
  if (v >= 0.55) return '还行';
  if (v >= 0.4) return '平常';
  if (v >= 0.25) return '有点低落';
  return '不太好';
}

const MOOD_HINT = {
  不错: '话可以多一点，语气轻快，愿意接梗',
  还行: '正常说话，偶尔开个玩笑',
  平常: '',
  有点低落: '句子短一点，回得懒一点，少发表情',
  不太好: '短、软、带点小情绪，可能会怼一句但别伤人',
};

const TRUST_HINT = (t) => (t >= 0.7 ? '你很信任他' : t >= 0.5 ? '你信得过他' : t >= 0.3 ? '你还在观察他' : '你对他有戒心');
const GUARD_HINT = (g) => (g >= 0.5 ? '你有点防备，别太热络' : g >= 0.3 ? '你留着一点距离' : '');

/** 当前状态的一句话摘要（给面板看，也给注入用）。 */
export function stateLine(st) {
  const m = moodLabel(st.mood.v);
  const bits = [`心情${m}`];
  if (st.emotion.intensity >= 1) bits.push('刚被戳到');
  bits.push(`信任 ${st.relation.trust.toFixed(2)}`, `亲密 ${st.relation.intimacy.toFixed(2)}`);
  if (st.relation.guard >= 0.3) bits.push(`戒备 ${st.relation.guard.toFixed(2)}`);
  return bits.join(' · ');
}

/**
 * 每轮注入块。返回空串表示这轮没什么可说的（状态全在基线）。
 * @param {object} st 已 settle 的状态
 * @param {number} [now] 现在。人格那句「我最近」要现拼，需要它才判得出过没过期。
 */
export function buildContext(st, now = 0) {
  const m = moodLabel(st.mood.v);
  const hint = MOOD_HINT[m] || '';
  const t = Number(now) || Number(st?.self?.at) || 0;
  const parts = [];
  if (hint) parts.push(`心情${m}：${hint}`);
  const g = GUARD_HINT(st.relation.guard);
  parts.push(`${TRUST_HINT(st.relation.trust)}${g ? '，' + g : ''}`);
  // 人格只在偏离基线明显时提一句，否则每天重复同一个形容词会把性格念死。
  // 有漂移叙事时用它（那是「她对自己变化的说法」），过期了才退回到特质词。
  const line = driftLine(st.self, t) || traitLine(st);
  if (line) parts.push(line.replace(/^（|）$/g, ''));

  return `（你现在的状态：${parts.join('；')}。这些只影响你怎么说话，不要说出口、不要解释；事实、数字、承诺、对他的评价一个字都不能变。）`;
}
