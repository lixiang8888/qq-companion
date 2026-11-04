// 规则版「评估」：一句话进来，给一个情绪事件和（可能的）关系伤害。
//
// 词表是设计选择，不是实证；改词表等于改性格，改动请连同测试一起改。
//
// 三条判据来自开源实现的对拍（dsh-character-presets 的 luna-emotion）：
//   否定翻转：「我不开心」不能命中「开心」；否定只在命中词前 4 字内生效，跨标点不算。
//   强度外溢：感叹号、连续重复字符（哈哈哈）、程度副词都会抬高或压低强度。
//   混合情绪：「气笑了」这类整词单独识别，输出一个中性的高唤醒状态。
//
// 一条本项目的规矩：对方说「我难过」是倾诉，不是攻击——记低落，不记账。

export const PRAISE = ['喜欢你', '爱你', '想你', '可爱', '好看', '漂亮', '聪明', '厉害', '真棒', '牛', '谢谢', '辛苦', '晚安', '早安', '抱抱', '摸摸', '贴贴', '乖', '宝贝', '爱了', '好吃', '开心', '高兴'];
export const INSULT = ['讨厌', '滚', '烦死', '闭嘴', '笨', '蠢', '傻', '丑', '垃圾', '废物', '恶心', '滚开', '别理我', '不理你'];
export const SAD = ['难过', '难受', '伤心', '委屈', '想哭', '好累', '撑不住'];
const NEGATIONS = ['不太', '不怎么', '没那么', '不够', '不', '没', '没有', '别', '不是', '并不', '才不'];
const MIXED = [
  { re: /气笑|气笑了/, label: '生气+好笑' },
  { re: /哭笑不得/, label: '无奈' },
];
const SOFTEN = ['有点', '稍微', '还算', '勉强'];

/** 某个词是否被否定：命中词前 4 字内有否定词，且中间没有标点。 */
function negatedAt(text, index) {
  const before = text.slice(Math.max(0, index - 4), index);
  if (/[，。！？,.!?；;]/.test(before)) return false;
  if (before.includes('特别') || before.includes('非常')) return false;
  return NEGATIONS.some((n) => before.endsWith(n));
}

/** 出现次数 + 极性（被否定的算反向）。 */
function scan(text, words) {
  let pos = 0;
  let neg = 0;
  for (const w of words) {
    let i = text.indexOf(w);
    while (i >= 0) {
      if (negatedAt(text, i)) neg += 1;
      else pos += 1;
      i = text.indexOf(w, i + w.length);
    }
  }
  return { pos, neg };
}

/** 强度：基础 + 感叹号 + 连续重复字符 + 程度词。 */
export function intensityOf(text) {
  const s = String(text || '');
  let v = 0.35;
  v += Math.min(2, (s.match(/[！!]/g) || []).length) * 0.15;
  if (/(.)\1{2,}/u.test(s)) v += 0.15;
  if (SOFTEN.some((w) => s.includes(w))) v -= 0.15;
  return Math.max(0.1, Math.min(1, v));
}

/**
 * @param {string} text 对方这一轮说的话
 * @param {{direct?: boolean}} [o] direct=false 表示这句不是对她说的（路过），强度打折
 * @returns {{emotion: {v:number,a:number,intensity:number,label?:string}|null, damage: number, mixed?: boolean}}
 */
export function appraise(text, { direct = true } = {}) {
  const t = String(text || '');
  if (!t.trim()) return { emotion: null, damage: 0 };

  const scale = direct ? 1 : 0.3;
  const praise = scan(t, PRAISE);
  const insult = scan(t, INSULT);
  const sad = scan(t, SAD);
  const mixedHit = MIXED.find((m) => m.re.test(t));
  const intensity = intensityOf(t) * scale;

  if (mixedHit) {
    return { emotion: { v: 0.5, a: 0.7, intensity, label: mixedHit.label }, damage: 0, mixed: true };
  }
  // 正向：夸，或者「否定式的骂」（你不讨厌）
  const positive = praise.pos + insult.neg;
  // 负向：骂，或者「否定式的夸」（我不开心）；倾诉不算负向攻击
  const negative = insult.pos + praise.neg;

  if (insult.pos > 0 && insult.pos >= praise.pos) {
    return {
      emotion: { v: 0.15, a: 0.75, intensity: Math.max(0.4, intensity), label: '被凶' },
      // 伤害只认「直接冲她来」的明确骂。
      damage: direct ? Math.min(0.1, 0.04 * insult.pos) : 0,
    };
  }
  if (sad.pos > 0) {
    return { emotion: { v: 0.25, a: 0.3, intensity, label: '低落' }, damage: 0 };
  }
  if (negative > positive) {
    return { emotion: { v: 0.3, a: 0.4, intensity, label: '低落' }, damage: 0 };
  }
  if (positive > negative) {
    return { emotion: { v: 0.8, a: 0.45, intensity, label: '被夸' }, damage: 0 };
  }
  if (/[？?]\s*$/.test(t)) {
    return { emotion: { v: 0.5, a: 0.55, intensity: 0.2 * scale, label: '被追问' }, damage: 0 };
  }
  return { emotion: null, damage: 0 };
}
