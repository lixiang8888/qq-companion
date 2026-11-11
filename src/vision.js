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
// 本地文件的读取额度比「发给接口」的上限宽得多：读进来还能压，接口那边可不能收 20MB。
// 真机上那张「我的天」是 20MB 的 GIF，名字却叫 .jpg——按 8MB 卡掉，她只能说「看不到」。
export const MAX_LOCAL_BYTES = 64 * 1024 * 1024;

const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

/** 按扩展名猜 MIME；官方说按内容判断，这里只是拼 data URL 用。 */
export function sniffMime(bytes) {
  const b = Buffer.from(bytes || []);
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.length > 3 && b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b.length > 3 && b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b.length > 11 && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

export function mimeOf(pathOrUrl = '') {
  const m = String(pathOrUrl).toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/);
  return MIME_BY_EXT[m?.[1]] || 'image/jpeg';
}

/** 从消息段里挑出图片（最多看几张，由调用方决定）。 */
export function imageSegmentsOf(segments) {
  // image 是普通图；mface/face 是表情包——它们也得能看，不然她手里只有「[表情]」。
  return (segments || []).filter((s) => {
    if (s?.type === 'image') return true;
    if (s?.type !== 'mface' && s?.type !== 'face') return false;
    const d = s.data || {};
    return Boolean(d.url || d.file || d.emoji_id);
  });
}

/**
 * 视频段。data 形状和图片差不多（url / file），所以来源解析直接复用 imageSourceOf。
 * 唯一区别：get_file 只认图片和语音的缓存，视频拿不到本地路径。
 */
export function videoSegmentsOf(segments) {
  return (segments || []).filter((s) => s?.type === 'video' && (s?.data?.url || s?.data?.file));
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
export async function describeImage({ dataUrl, dataUrls, key, prompt = '', fetchImpl = globalThis.fetch, model = VISION_MODEL, baseUrl = VISION_BASE, timeoutMs = 30000 } = {}) {
  const list = (Array.isArray(dataUrls) && dataUrls.length ? dataUrls : [dataUrl]).filter(Boolean);
  if (!list.length) return { ok: false, reason: '没有图' };
  if (!key) return { ok: false, reason: '没有可用的 key' };
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: 800, // 推理模型会先用掉一截 token，给少了正文就是空的
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt || '用一两句话描述这张图里有什么：画的是什么、有没有文字（有就照抄）、什么气氛。只描述，不评价、不猜测背景。' },
            ...list.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 400 的正文里通常写着到底哪不对（格式、大小、内容），只报状态码等于什么都没说。
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      const why = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
      return { ok: false, reason: `HTTP ${res.status}${why ? `：${why}` : ''}` };
    }
    const body = await res.json().catch(() => null);
    const text = String(body?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) return { ok: false, reason: '模型没给描述' };
    return { ok: true, text, usage: body?.usage ?? null };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/**
 * 把描述塞回正文，替换掉那个占位的 [图片]。
 * 看不到的时候，如果 QQ 自己带了表情名（summary，例如「[哈哈]」），就把这个名字说出来——
 * 名字是腾讯给的，不是她猜的。
 */
export function withImageText(text, descriptions = [], names = []) {  const usable = descriptions.filter((d) => d?.ok && d.text);
  if (!usable.length) {
    const known = (names || []).filter(Boolean);
    const hint = known.length ? `他发的表情叫「${known[0]}」` : '他发了一张图';
    return `${text}（${hint}，你看不到内容——别猜，就说你看不到）`.trim();
  }
  // 说成「你看到了什么」，而不是「有人给了你一段图注」——
  // 后者会让她把图注念一遍（真机上每次都「看到了，……」）。
  const line = usable.map((d) => `（你看了一眼他刚发来的图：${d.text}。知道就行，别复述）`).join('');
  return `${line}${text}`.trim();
}







/**
 * 静态大图先缩小再发。QQ 的「原图」动辄十几兆，直接 base64 过去接口会 400。
 * 只要第一帧（pages: 1）：这个函数是给「抽帧失败、又不是普通小图」的兜底用的。
 * 压不动返回 null——宁可说看不到，也不要发一个注定被拒的请求。
 */
export async function shrinkImage(bytes, { max = 1024, sharpImpl = null, quality = 78 } = {}) {
  let sharp = sharpImpl;
  if (!sharp) {
    try { sharp = (await import('sharp')).default; } catch { return null; }
  }
  try {
    return await sharp(bytes, { pages: 1 })
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
  } catch {
    return null;
  }
}

/** 从 pages 帧里挑几张：均匀采样，首尾都取到。 */
export function pickFrameIndexes(pages, max = 4) {
  const n = Math.floor(Number(pages) || 0);
  if (n <= 0 || max <= 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out = [];
  for (let i = 0; i < max; i++) out.push(Math.round((i * (n - 1)) / (max - 1)));
  return [...new Set(out)];
}

/**
 * 动图抽帧：把 GIF / 动态 WebP 拆成几张图。
 * sharp 只在真的需要时才 import——没装或者坏掉的话，退化成「只看第一帧」，不该拖垮回话。
 *
 * 一定要缩、一定要转 JPEG：真机上收过一个 300×11700 的表情包，四帧 PNG 合计 3.4 MB，
 * base64 之后请求体 4.5 MB，接口直接 400——她只能说「还是看不到」。
 * 表情包是给人瞥一眼的，320px 的 JPEG 足够看清在干嘛。
 */
export async function extractGifFrames(bytes, { max = 4, sharpImpl = null, size = 320, budgetBytes = 1_200_000 } = {}) {
  let sharp = sharpImpl;
  if (!sharp) {
    try { sharp = (await import('sharp')).default; } catch { return null; }
  }
  try {
    const meta = await sharp(bytes, { animated: true }).metadata();
    const pages = Number(meta?.pages) || 1;
    if (pages <= 1) return null;
    const frames = [];
    let total = 0;
    for (const page of pickFrameIndexes(pages, max)) {
      // pages: 1 是必须的。只给 { page } 的话 sharp 返回的是「从这一页开始、往下全部」的叠加图
      // ——一个 300×11700 的表情包会变成 300×8700、1.6MB 的大图，接口直接 400。
      const jpg = await sharp(bytes, { animated: true, page, pages: 1 })
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      const url = dataUrlOf(jpg, 'image/jpeg');
      // 预算兜底：攒超了就只留已经拿到的（至少有一帧能看）。
      if (total + url.length > budgetBytes && frames.length) break;
      frames.push(url);
      total += url.length;
    }
    return { pages, frames };
  } catch {
    return null;
  }
}

/** 多帧交给模型时用的那句话：说清楚这是同一个动图的不同时刻。 */
export const ANIMATION_PROMPT = '这是同一个动图按时间顺序取的几帧。用一两句话说明它在做什么动作：谁在动、怎么动、有没有循环。只描述，不评价。';
