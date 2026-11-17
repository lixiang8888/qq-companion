// 她读书：从安卓里的 Legado 取正文。
//
// 为什么绕这么远：网文站基本都有 JS 渲染/反爬，直接抓页面实测 24 个源 0 个能读。
// Legado 替我们跑那 176 条书源规则，它自己开一个 Web 服务（默认 1122），
// 插件只跟这个 HTTP 说话——后端是模拟器、手机还是别的安卓壳，这里一点都不关心。
//
// 三个接口（真机实测过）：
//   GET /getBookshelf                       书架（bookUrl / totalChapterNum / durChapterIndex）
//   GET /getChapterList?url=<bookUrl>       目录（index / title）
//   GET /getBookContent?url=<bookUrl>&index=N   正文（data）
// 注意参数名就叫 url，传书的地址，不是章节地址；传 bookUrl 才会命中缓存。

export const DEFAULT_BASE = 'http://127.0.0.1:1123';
const TIMEOUT_MS = 25000;

/** 站点塞在正文里的广告句。整行命中就丢掉——宁可少一句，也别让她念广告。 */
const AD = /(小说尽在|请认准|最新章节|全文阅读|无弹窗|手机阅读|本章未完|一秒记住|百度搜索|www\.|https?:\/\/)/i;

/**
 * 洗正文：去站点广告、去行首全角缩进、合并多余空行。
 * 正文是模型要读的东西，宁可干净一点——一条广告会让她以为那是剧情。
 */
export function cleanText(raw) {
  const lines = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[\u3000\s]+/g, ' ').trim())
    .filter((l) => l && !AD.test(l));
  return lines.join('\n');
}

/**
 * 这次读第几章：接着上次往后一章；读完了就从头再来（她可以重读，也算真事）。
 * @returns {{index:number, wrapped:boolean}}
 */
export function nextChapter({ lastIndex = -1, total = 0 } = {}) {
  const t = Math.max(0, Math.round(Number(total) || 0));
  if (t === 0) return { index: 0, wrapped: false };
  const last = Math.round(Number(lastIndex));
  const next = (Number.isFinite(last) ? last : -1) + 1;
  if (next <= 0) return { index: 0, wrapped: false };
  if (next >= t) return { index: 0, wrapped: true };
  return { index: next, wrapped: false };
}

function makeClient({ base = DEFAULT_BASE, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const url = (path, params = {}) => {
    const u = new URL(path, base.endsWith('/') ? base : `${base}/`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u.href;
  };
  async function getJson(href, { strict = true } = {}) {
    const res = await fetchImpl(href, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res?.ok) throw new Error(`读书后端返回 HTTP ${res?.status ?? '?'}`);
    const body = await res.json();
    // 书架空的时候后端也回 isSuccess:false（errorMsg「还没有添加小说」）。
    // 那不是故障，是她还没书读——所以书架那条不按 strict 判。
    if (strict && body?.isSuccess === false) throw new Error(String(body.errorMsg || '读书后端说不行'));
    return body;
  }
  return {
    /** 书架上有什么。空书架返回空数组——那不是错误，是她还没书读。 */
    async shelf() {
      const body = await getJson(url('getBookshelf'), { strict: false });
      const list = Array.isArray(body?.data) ? body.data : [];
      return list.map((b) => ({
        name: String(b?.name || ''),
        author: String(b?.author || ''),
        bookUrl: String(b?.bookUrl || ''),
        total: Math.max(0, Math.round(Number(b?.totalChapterNum) || 0)),
        lastIndex: Number.isFinite(Number(b?.durChapterIndex)) ? Number(b.durChapterIndex) : -1,
      })).filter((b) => b.bookUrl);
    },
    /** 目录：只取 index 和标题，章节 url 用不上（正文接口只认 bookUrl + index）。 */
    async chapters(bookUrl) {
      const body = await getJson(url('getChapterList', { url: bookUrl }));
      const list = Array.isArray(body?.data) ? body.data : [];
      return list.map((c, i) => ({ index: Number.isFinite(Number(c?.index)) ? Number(c.index) : i, title: String(c?.title || '') }));
    },
    /** 一章正文。返回洗过的文本和字数——字数是给闸门用的（太短说明这条源坏了）。 */
    async chapter(bookUrl, index) {
      const body = await getJson(url('getBookContent', { url: bookUrl, index }));
      const text = cleanText(body?.data);
      return { index, text, chars: text.length };
    },
  };
}

export function createNovel(opts) {
  return makeClient(opts);
}

// ---- 什么时候该看书，看完怎么记 ----

export const BORED_QUIET_MS = 2 * 3600e3;   // 他安静这么久，她才开始无聊
export const READ_GAP_MS = 6 * 3600e3;      // 两次读之间至少隔这么久
export const READS_PER_DAY = 2;             // 一天最多读两章：一章两千多字，读多了烧钱也读不出味道
export const READ_MAX_CHARS = 3000;         // 喂给模型的正文上限

/**
 * 她现在该不该去看书。
 *
 * 判据全是真事：他多久没说话、上次读是什么时候、今天读了几章、心情如何。
 * 心情太低不读——那种时候看书不是消遣，是躲。
 */
export function isBored({ now = 0, lastUserAt = 0, lastReadAt = 0, readsToday = 0, mood = 0.5, hasBook = true } = {}) {
  if (!hasBook) return false;
  if (Number(mood) < 0.4) return false;
  if (Number(readsToday) >= READS_PER_DAY) return false;
  const sinceRead = lastReadAt ? now - Number(lastReadAt) : Infinity;
  if (sinceRead < READ_GAP_MS) return false;
  if (!lastUserAt) return false;
  return now - Number(lastUserAt) >= BORED_QUIET_MS;
}

/** 看完之后的进度。章数、书名都记下来，下次接着读。 */
export function noteRead(state = {}, { now = 0, book = {}, index = 0, title = '', thought = '' } = {}) {
  return {
    bookUrl: String(book.bookUrl || state.bookUrl || ''),
    bookName: String(book.name || state.bookName || ''),
    index: Math.max(0, Math.round(Number(index) || 0)),
    title: String(title || ''),
    thought: String(thought || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    at: now,
  };
}

/** 注入给她的那一行。没有就不写——空块比假句子好。 */
export function novelLine(state, now = 0) {
  const name = String(state?.bookName || '').trim();
  const at = Number(state?.at) || 0;
  if (!name || !at) return '';
  const hours = Math.round((now - at) / 3600e3);
  const when = hours < 1 ? '刚才' : hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
  const where = state.title ? `第 ${Number(state.index) + 1} 章「${state.title}」` : `第 ${Number(state.index) + 1} 章`;
  const thought = String(state.thought || '').trim();
  return `你${when}自己在看《${name}》，读到${where}${thought ? `，当时想的是：「${thought}」` : ''}。`;
}
