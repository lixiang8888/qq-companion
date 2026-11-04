// OneBot v11 消息事件 → 本插件用的统一形状。
//
// 只做纯映射，不碰网络：这样协议细节（段类型、at、图片、引用）可以在测试里钉死，
// 真机调试时只需要怀疑传输层。

const SEG_LABEL = {
  image: '[图片]',
  face: '[表情]',
  mface: '[表情]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  json: '[卡片]',
  xml: '[卡片]',
  forward: '[转发]',
  markdown: '[卡片]',
};

function segText(seg) {
  if (!seg || typeof seg !== 'object') return '';
  if (seg.type === 'text') return String(seg.data?.text ?? '');
  if (seg.type === 'at') {
    const name = seg.data?.name ? `@${seg.data.name}` : '@某人';
    return `${name} `;
  }
  return SEG_LABEL[seg.type] || `[${seg.type}]`;
}

/**
 * @returns {null | {chatId,kind,userId,groupId,text,messageId,nickname,at,segments}}
 */
export function normalizeMessage(ev) {
  if (!ev || ev.post_type !== 'message') return null;
  const kind = ev.message_type === 'group' ? 'group' : 'private';
  const userId = String(ev.user_id ?? '');
  const groupId = kind === 'group' ? String(ev.group_id ?? '') : '';
  if (!userId) return null;
  if (kind === 'group' && !groupId) return null;

  const segs = Array.isArray(ev.message) ? ev.message : [];
  const text = segs.length
    ? segs.map(segText).join('').trim()
    : String(ev.raw_message ?? '').trim();

  return {
    chatId: kind === 'group' ? `group:${groupId}` : `private:${userId}`,
    kind,
    userId,
    groupId,
    text,
    messageId: String(ev.message_id ?? ''),
    nickname: String(ev.sender?.card || ev.sender?.nickname || ''),
    at: (Number(ev.time) || Math.floor(Date.now() / 1000)) * 1000,
    segments: segs,
  };
}

const OPEN = { '（': '）', '(': ')', '【': '】', '[': ']', '「': '」', '『': '』', '{': '}', '《': '》' };
const CLOSE = new Set(['）', ')', '】', ']', '」', '』', '}', '》']);
const BREAK = new Set(['。', '！', '？', '!', '?', '…', '；', ';']);

/** 按句末标点切句，括号里的标点不算——颜文字 `(´；ω；｀)` 不能被切两半。 */
function sentenceUnits(line) {
  const units = [];
  let buf = '';
  let depth = 0;
  for (const ch of Array.from(line)) {
    buf += ch;
    if (OPEN[ch] !== undefined) depth += 1;
    else if (CLOSE.has(ch)) depth = Math.max(0, depth - 1);
    else if (BREAK.has(ch) && depth === 0) { units.push(buf); buf = ''; }
  }
  if (buf.trim()) units.push(buf);
  return units;
}

/** 单句自己就超长时才硬切：尽量切在括号外，实在找不到就原地切（绝不因为括号没闭合就卡住）。 */
function hardSplit(unit, maxChars) {
  const out = [];
  let rest = Array.from(unit);
  while (rest.length > maxChars) {
    let depth = 0;
    let safe = 0;
    for (let i = 0; i < rest.length && i < maxChars; i++) {
      const ch = rest[i];
      if (OPEN[ch] !== undefined) depth += 1;
      else if (CLOSE.has(ch)) depth = Math.max(0, depth - 1);
      if (depth === 0) safe = i + 1;
    }
    const cut = safe > 0 ? safe : maxChars;
    out.push(rest.slice(0, cut).join(''));
    rest = rest.slice(cut);
  }
  if (rest.length) out.push(rest.join(''));
  return out;
}

/**
 * 拆条：按换行拆，最多 4 条；单条过长时按句末标点再拆，保证「不断句、不甩小作文」。
 * 真模型偶尔会吐一整段，直接发出去既不像人也会被风控盯上。
 */
export function splitReply(text, { max = 4, maxChars = 300 } = {}) {
  const raw = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const parts = [];
  for (const line of raw) {
    if (line.length <= maxChars) { parts.push(line); continue; }
    let buf = '';
    for (const unit of sentenceUnits(line)) {
      if (unit.length <= maxChars) {
        if (buf && buf.length + unit.length > maxChars) { parts.push(buf); buf = ''; }
        buf += unit;
        continue;
      }
      if (buf) { parts.push(buf); buf = ''; }
      const pieces = hardSplit(unit, maxChars);
      parts.push(...pieces.slice(0, -1));
      buf = pieces[pieces.length - 1];
    }
    if (buf) parts.push(buf);
  }
  return parts.slice(0, max);
}
