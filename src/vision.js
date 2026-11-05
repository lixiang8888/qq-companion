// 看图：把 QQ 里收到的图片交给 deepseek-flash 看一眼，拿回一段文字描述。
//
// 为什么要绕这么一下：她的对话走 DSH 的文本接口，模型看到的是「[图片]」三个字。
// 与其让她猜（真机上就编过「粉头小人倒立竖拇指」），不如先让模型看图、把描述变成文字，
// 她再读到「他发了一张图：……」。代价是每张图多一次调用。
//
// 官方限制（2026-11 文档）：单图 ≤32 MiB，格式按内容判断，JPEG/PNG/GIF/WebP。

export const VISION_MODEL = 'deepseek-flash';
export const VISION_BASE = 'https://api.deepseek.com';
/** 保守上限：超过就不看，别为了看图把请求撑爆。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

/** 按扩展名猜 MIME；官方说按内容判断，这里只是拼 data URL 用。 */
export function mimeOf(pathOrUrl = '') {
  const m = String(pathOrUrl).toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/);
  return MIME_BY_EXT[m?.[1]] || 'image/jpeg';
}

/** 从消息段里挑出图片（最多看几张，由调用方决定）。 */
export function imageSegmentsOf(segments) {
  return (segments || []).filter((s) => s?.type === 'image');
}

/**
 * 一张图的来源。SnowLuma 给的东西不固定，三种都认：
 *   data.url  = http(s) 链接 → 下载
 *   data.url  = file:// 或磁盘路径 → 直接读
 *   data.file = 磁盘路径 → 直接读
 * 认不出来就返回 null（调用方负责说「看不到」）。
 */
export function imageSourceOf(seg) {
  const d = seg?.data || {};
  const url = String(d.url ?? '');
  if (/^https?:\/\//i.test(url)) return { kind: 'url', value: url };
  if (/^file:\/\//i.test(url)) return { kind: 'file', value: url.replace(/^file:\/\//i, '') };
  const file = String(d.file ?? '');
  if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith('/')) return { kind: 'file', value: file };
  if (/^[a-zA-Z]:[\\/]/.test(url) || url.startsWith('/')) return { kind: 'file', value: url };
  return null;
}

/** 拼成 data URL（OpenAI 兼容接口要的就是这个）。 */
export function dataUrlOf(bytes, mime = 'image/jpeg') {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * 让模型描述一张图。失败一律返回 {ok:false}，绝不抛——看图失败不该让她哑掉。
 */
export async function describeImage({ dataUrl, key, fetchImpl = globalThis.fetch, model = VISION_MODEL, baseUrl = VISION_BASE, timeoutMs = 30000 } = {}) {
  if (!dataUrl) return { ok: false, reason: '没有图' };
  if (!key) return { ok: false, reason: '没有可用的 key' };
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '用一两句话描述这张图里有什么：画的是什么、有没有文字（有就照抄）、什么气氛。只描述，不评价、不猜测背景。' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const text = String(body?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) return { ok: false, reason: '模型没给描述' };
    return { ok: true, text, usage: body?.usage ?? null };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/** 把描述塞回正文，替换掉那个占位的 [图片]。 */
export function withImageText(text, descriptions = []) {
  const usable = descriptions.filter((d) => d?.ok && d.text);
  if (!usable.length) {
    return `${text}（他发了一张图，你看不到内容——别猜，就说你看不到）`.trim();
  }
  const line = usable.map((d) => `[他发了一张图：${d.text}]`).join('');
  return `${line}${text}`.trim();
}
