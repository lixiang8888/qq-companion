// 她的表情包：账号的收藏表情。
//
// 以前以为要自建目录，其实网关支持 fetch_custom_face_detail——13 张、带 url。
// 唯一缺的是「这张是什么意思」：desc 全是空的，所以她没法挑。
// 所以这里做三件事：拉列表、让视觉模型给每张起个短名、按名字挑一张。
//
// 边界：不联网搜图。搜来的图她不知道好不好笑，只会变成随机图。
// 也不下载落盘——发出去直接用 url，网关自己去取。

export const MAX_NAME = 8;
export const MAX_LISTED = 24;
export const LIST_CHARS = 160;

/** 起名用的提示：只要情绪或梗，不要描述画面。 */
export const NAME_PROMPT = '这是一张聊天表情包。用不超过 6 个字说出它的情绪或梗（比如「无语」「委屈」「笑死」）。只回这几个字，不要标点，不要解释画面。';

/** 网关返回的收藏列表 → 我们存的那份。 */
export function parseFavorites(data) {
  return (Array.isArray(data) ? data : [])
    .map((d, i) => ({
      md5: String(d?.md5 || d?.emoji_id || `i${i}`),
      url: String(d?.url || ''),
      name: String(d?.desc || '').trim().slice(0, MAX_NAME),
    }))
    .filter((s) => s.url);
}

/** 已有的索引 + 新拉到的列表：老的名字要留住，否则每次同步都重新起名。 */
export function mergeFavorites(prev = [], fresh = []) {
  const byMd5 = new Map((prev || []).map((s) => [s.md5, s]));
  return fresh.map((s) => {
    const old = byMd5.get(s.md5);
    return { md5: s.md5, url: s.url, name: old?.name || s.name || '' };
  });
}

/**
 * 按她说的挑一张。挑不到就返回 null——**宁可这次没有表情，也不要拿一张不相干的顶替**，
 * 那比没有更糟：她以为自己在说「无语」，他看到的是一张笑脸。
 */
export function pickSticker(items = [], hint = '') {
  const h = String(hint || '').trim();
  if (!items.length || !h) return null;
  const named = items.filter((s) => s.name);
  const exact = named.find((s) => s.name === h);
  if (exact) return exact;
  const loose = named.find((s) => s.name.includes(h) || h.includes(s.name));
  return loose || null;
}

/** 注入上下文的那一行：只有名字，没有 url，没有文件路径。 */
export function namesLine(items = [], { max = MAX_LISTED, maxChars = LIST_CHARS } = {}) {
  const names = (items || []).map((s) => String(s.name || '').trim()).filter(Boolean);
  if (!names.length) return '';
  const picked = [];
  let used = 0;
  for (const n of names.slice(0, max)) {
    if (used + n.length + 1 > maxChars) break;
    picked.push(n);
    used += n.length + 1;
  }
  return `【你手上的表情】${picked.join('、')}（想发就写 [表情:名字]，别把方括号念出来）`;
}

/** 还没名字的那几张——同步时只给这些花视觉调用，不重复起名。 */
export const needNames = (items = []) => (items || []).filter((s) => s.url && !s.name);
