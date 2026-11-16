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
// 亲密：她不是什么都接，是会不好意思的。分两档是因为「刚洗完澡」和露骨的话不是同一件事。
// 词表是设计选择，不是实证——和 PRAISE 那条一样，改它等于改性格。
// 注意别往 MILD 里放 PRAISE 里已有的词（抱抱/摸摸/贴贴）：那会把「被夸」整个吃成「羞」。
export const INTIMATE_MILD = ['洗澡', '洗完澡', '洗了个澡', '没穿', '只穿', '床上', '一起睡', '睡衣'];
export const INTIMATE_BOLD = ['🦌', '想要你', '想上你', '亲你', '摸你', '脱掉', '做那种', '弄了', '硬了', '湿了'];
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
 * 没命中任何词表的那句话也可能很有分量：吼出来的、连发感叹号的、一口气说很长的。
 * 给它一个温热的底，别让那些瞬间按闲话老化——她记得什么，全靠这个数。
 * 上限压在 HEAT_KEEP(0.6) 下面：兜底归兜底，不能冒充"那一刻我很重"。
 */
export function fallbackHeat(text) {
  const s = String(text || '');
  let v = 0;
  v += Math.min(2, (s.match(/[！!]/g) || []).length) * 0.12;
  if (/(.)\1{2,}/u.test(s)) v += 0.1;
  if (s.length >= 30) v += 0.12;
  if (/[😭😢🥺💔]/u.test(s)) v += 0.1;
  return Math.min(0.45, Math.round(v * 100) / 100);
}

/**
 * @param {string} text 对方这一轮说的话
 * @param {{direct?: boolean}} [o] direct=false 表示这句不是对她说的（路过），强度打折
 * @returns {{emotion: {v:number,a:number,intensity:number,label?:string}|null, damage: number, heat: number, mixed?: boolean}}
 */
export function appraise(text, { direct = true } = {}) {
  const t = String(text || '');
  if (!t.trim()) return { emotion: null, damage: 0, heat: 0 };

  const scale = direct ? 1 : 0.3;
  const praise = scan(t, PRAISE);
  const insult = scan(t, INSULT);
  const sad = scan(t, SAD);
  const mixedHit = MIXED.find((m) => m.re.test(t));
  const intensity = intensityOf(t) * scale;

  if (mixedHit) {
    // 「气笑了」是还占着上风的无奈，「哭笑不得」是真的没辙——差别就在支配度。
    const d = mixedHit.label === '无奈' ? 0.38 : 0.58;
    return { emotion: { v: 0.5, a: 0.7, d, intensity, label: mixedHit.label }, damage: 0, heat: intensity, mixed: true };
  }
  // 正向：夸，或者「否定式的骂」（你不讨厌）
  const positive = praise.pos + insult.neg;
  // 负向：骂，或者「否定式的夸」（我不开心）；倾诉不算负向攻击
  const negative = insult.pos + praise.neg;

  if (insult.pos > 0 && insult.pos >= praise.pos) {
    return {
      emotion: { v: 0.15, a: 0.75, d: 0.25, intensity: Math.max(0.4, intensity), label: '被凶' },
      // 伤害只认「直接冲她来」的明确骂。
      damage: direct ? Math.min(0.1, 0.04 * insult.pos) : 0,
      heat: Math.max(0.4, intensity),
    };
  }
  // 羞：低愉悦、高唤醒、低支配。放在「低落」前面，因为他撩她的时候她不是难过。
  // 支配度是它和「恼」的唯一分界：同样心跳快，一个说不出话，一个想顶回去。
  const bold = INTIMATE_BOLD.some((w) => t.includes(w));
  const mild = INTIMATE_MILD.some((w) => t.includes(w)) && !bold;
  if (bold || mild) {
    const strong = bold ? Math.max(0.55, intensity) : Math.max(0.35, intensity * 0.7);
    return { emotion: { v: 0.45, a: 0.8, d: 0.2, intensity: strong, label: '羞' }, damage: 0, heat: strong };
  }
  if (sad.pos > 0) {
    return { emotion: { v: 0.25, a: 0.3, d: 0.3, intensity, label: '低落' }, damage: 0, heat: intensity };
  }
  if (negative > positive) {
    return { emotion: { v: 0.3, a: 0.4, d: 0.32, intensity, label: '低落' }, damage: 0, heat: intensity };
  }
  if (positive > negative) {
    return { emotion: { v: 0.8, a: 0.45, d: 0.6, intensity, label: '被夸' }, damage: 0, heat: intensity };
  }
  if (/[？?]\s*$/.test(t)) {
    return { emotion: { v: 0.5, a: 0.55, d: 0.4, intensity: 0.2 * scale, label: '被追问' }, damage: 0, heat: 0.2 * scale };
  }
  return { emotion: null, damage: 0, heat: fallbackHeat(t) };
}
