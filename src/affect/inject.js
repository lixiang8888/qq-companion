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
// 底气：低的时候抬不起头，高的时候说话敢冲一点。
// 这一条和标签分开写，因为标签会先散（强度归零就清），底气散得慢——那是"底色"。
const D_HINT = (d) => (d <= 0.35 ? '你有点没底气，别硬撑' : d >= 0.7 ? '你现在底气足，说话可以冲一点' : '');

// 每个情绪标签都要能让这句话变一点。做不到的话它就是个装饰品，不该存在
// （affect.test 里有一条遍历所有标签的测试守着这条）。
const LABEL_HINT = {
  羞: '你有点不好意思：话说得绕，别说得太直白',
  被凶: '你被扎了一下：短一点，别哄他',
  被夸: '你心里美了一下：语气可以软一点',
  低落: '你有点闷：话少，别硬撑热闹',
  '生气+好笑': '你又好气又好笑：可以怼一句，但别真翻脸',
  无奈: '你有点没辙：叹口气，别争',
  被追问: '他在追着问：答一句就够，别展开',
  // 读书那七个标签（novel.js 的 REACTIONS）。一节看下来有滋味，说话就会跟着变。
  爽: '你被爽到了：语气可以跳一点，别端着',
  触动: '你刚被戳了一下：话可以软，别说得太满',
  酸: '你心里有点发酸：句子短，别逗他',
  闷: '你有点闷：话少，别硬撑热闹',
  尬: '你替人尴尬：可以吐槽一句，别认真',
  烦: '你有点不耐烦：短、冲一点，别哄他',
};

/** 当前状态的一句话摘要（给面板看，也给注入用）。 */
export function stateLine(st) {
  const m = moodLabel(st.mood.v);
  const bits = [`心情${m}`];
  if (st.emotion.intensity >= 1) bits.push('刚被戳到');
  if (st.emotion.label) bits.push(st.emotion.label);
  const d = Number(st?.emotion?.d);
  if (Number.isFinite(d) && (d <= 0.35 || d >= 0.7)) bits.push(`底气 ${d.toFixed(2)}`);
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
  const labelHint = LABEL_HINT[st?.emotion?.label] || '';
  if (labelHint) parts.push(labelHint);
  // 有标签的时候标签已经把话说完了，不再叠一条底气的；标签散掉之后才轮到它——
  // 那正是"刚才那件事过去了，可她还是抬不起头"的那一段。
  const dHint = labelHint ? '' : D_HINT(Number(st?.emotion?.d ?? 0.5));
  if (dHint) parts.push(dHint);
  const g = GUARD_HINT(st.relation.guard);
  parts.push(`${TRUST_HINT(st.relation.trust)}${g ? '，' + g : ''}`);
  // 人格只在偏离基线明显时提一句，否则每天重复同一个形容词会把性格念死。
  // 有漂移叙事时用它（那是「她对自己变化的说法」），过期了才退回到特质词。
  const line = driftLine(st.self, t) || traitLine(st);
  if (line) parts.push(line.replace(/^（|）$/g, ''));

  return `（你现在的状态：${parts.join('；')}。这些只影响你怎么说话，不要说出口、不要解释；事实、数字、承诺、对他的评价一个字都不能变。）`;
}
