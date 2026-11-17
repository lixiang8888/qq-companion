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
 * 这次读哪一章。
 *
 * 为什么要按「章号」而不是按数组下标往后走：他遇到的真事——有的书源目录里章节会重复
 * （同一章出现两次）、有的会缺（第 300 章后面直接是 302）。按下标走，撞上重复就重读一遍，
 * 撞上缺失就少读一章还不知道。按章号走两个问题一起解决：
 *   - 只在章号比上次大时才读 → 重复的那条永远不会被选中
 *   - 跳号就说明缺章，返回 gap 让调用方知道（不是她的错，也不用假装读过）
 * 没有章号（番外、卷名）的书退回按下标走，并跳过标题读过的那些。
 *
 * @returns {{index:number, title:string, num:number|null, gap:number, wrapped:boolean}}
 */
export function planRead(chapters = [], state = {}) {
  const list = [...(chapters || [])].filter((c) => Number.isFinite(Number(c?.index))).sort((a, b) => a.index - b.index);
  if (!list.length) return { index: 0, title: '', num: null, gap: 0, wrapped: false };

  const titleOf = (c) => String(c?.title || '').trim();
  const numOf = (c) => { const m = /第\s*(\d+)\s*[章节]/.exec(titleOf(c)); return m ? Number(m[1]) : null; };
  const read = new Set((state.readTitles || []).map((t) => String(t).trim()));
  const lastNum = Number.isFinite(Number(state.lastNum)) && state.lastNum !== null ? Number(state.lastNum) : null;
  const pick = (c, gap = 0, wrapped = false) => ({ index: Number(c.index), title: titleOf(c), num: numOf(c), gap, wrapped });

  // 一、按章号往后：跳过重复，缺章如实报出来
  if (lastNum !== null) {
    for (const c of list) {
      const n = numOf(c);
      if (n === null || n <= lastNum) continue;
      if (read.has(titleOf(c))) continue;
      return pick(c, Math.max(0, n - lastNum - 1));
    }
  }
  // 二、从上次的下标往后，跳过读过的标题
  const from = Number.isFinite(Number(state.index)) ? Number(state.index) + 1 : 0;
  for (let i = from; i < list.length; i++) if (!read.has(titleOf(list[i]))) return pick(list[i]);
  // 三、全读过了：从头再来（重读也是真事，不是错误）
  for (const c of list) if (!read.has(titleOf(c))) return pick(c, 0, true);
  return pick(list[0], 0, true);
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
export const READ_GAP_MS = 10 * 60e3;       // 两章之间至少隔一次心跳，别在一个 tick 里连读
export const READS_PER_DAY = 80;            // 一天最多读这么多章（他定的）
export const READ_MAX_CHARS = 3000;         // 喂给模型的正文上限
export const READ_TITLES_KEEP = 60;         // 记住最近读过的标题：靠它躲开目录里的重复章

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

/** 看完之后的进度。章号用来躲重复，标题用来躲缺章之后的重读。换书就重新开始算。 */
export function noteRead(state = {}, { now = 0, book = {}, index = 0, title = '', num = null, thought = '' } = {}) {
  const bookUrl = String(book.bookUrl || state.bookUrl || '');
  const sameBook = bookUrl === String(state.bookUrl || '');
  const keep = sameBook ? [String(title || '').trim(), ...(state.readTitles || [])] : [String(title || '').trim()];
  return {
    bookUrl,
    bookName: String(book.name || state.bookName || ''),
    index: Math.max(0, Math.round(Number(index) || 0)),
    title: String(title || ''),
    lastNum: Number.isFinite(Number(num)) ? Number(num) : (sameBook ? (state.lastNum ?? null) : null),
    readTitles: keep.filter(Boolean).slice(0, READ_TITLES_KEEP),
    thought: String(thought || '').replace(/\s+/g, ' ').trim().slice(0, 120),
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
