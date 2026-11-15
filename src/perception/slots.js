// 视觉模型的一次输出 → 标题 / 完整描述 / 结构化语义槽。
//
// 为什么要结构化而不是一句散文：检索要能对上「粉头发的那个」，一句散文靠 2-gram 太容易漏。
// 但**描述不能丢**——这一轮的正文和记忆卡的「他发了一张图」识别全靠它，
// 所以模型不按格式回时，宁可退化成一句散文，也不能不存图。

export const SLOT_KINDS = ['who', 'what', 'where', 'action', 'look'];
const MAX_TITLE = 30;
const MAX_DESC = 400;
const MAX_TERM = 12;
const MAX_TERMS = 4;

const cut = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 剥掉代码围栏和前后杂字，留下最像 JSON 的那一段。 */
function jsonish(text) {
  const s = String(text ?? '').replace(/```[a-z]*\n?/gi, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function emptySlots() {
  const out = {};
  for (const k of SLOT_KINDS) out[k] = [];
  return out;
}

/** 槽值只收「非空字符串数组」，每类最多 4 个、每个最多 12 字。别的一律丢掉。 */
function cleanSlots(raw) {
  const out = emptySlots();
  if (!raw || typeof raw !== 'object') return out;
  for (const k of SLOT_KINDS) {
    const v = raw[k];
    if (!Array.isArray(v)) continue;
    out[k] = v.map((x) => cut(x, MAX_TERM)).filter(Boolean).slice(0, MAX_TERMS);
  }
  return out;
}

/**
 * @param {string} text 模型这一轮的回复（可能是 JSON，也可能是散文）
 * @returns {{title: string, desc: string, slots: object}}
 */
export function parsePerception(text) {
  const raw = String(text ?? '').trim();
  const j = jsonish(raw);
  if (j && typeof j === 'object') {
    const desc = cut(j.desc, MAX_DESC) || cut(j.title, MAX_DESC);
    const title = cut(j.title, MAX_TITLE) || desc.slice(0, MAX_TITLE);
    return { title, desc, slots: cleanSlots(j.slots) };
  }
  const desc = cut(raw, MAX_DESC);
  return { title: desc.slice(0, MAX_TITLE), desc, slots: emptySlots() };
}

/** 检索用的文本：标题 + 描述 + 所有槽，拼成一串给 memory/search.js 的 2-gram 去切。 */
export function slotsText(rec = {}) {
  const parts = [rec.title, rec.desc];
  const slots = rec.slots && typeof rec.slots === 'object' ? rec.slots : {};
  for (const k of SLOT_KINDS) {
    const v = slots[k];
    if (Array.isArray(v)) parts.push(...v);
  }
  return parts.filter(Boolean).join(' ');
}
