// 她读书：从安卓里的 Legado 取正文。
// Legado = https://github.com/gedoor/legado（原 GPL-3.0；上游 2026-05 被作者清空，见 THIRD_PARTY_NOTICES.md）
// 我们只调它的本地 HTTP，不打包、不复制代码——仓库里没有它的任何东西。
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
const AD = /(小说尽在|请认准|最新章节|全文阅读|无弹窗|手机阅读|本章未完|一秒记住|百度搜索|www\s*[.．]|https?:\/\/)/i;

/** 站名单独成短行时也是广告（「顶点小说」「笔趣阁」…）。 */
const SITE = /(顶点小说|玄幻阁|笔趣阁|唐三中文网|如书包|香书小说|无双小说网|醉读小说|吃鸡小说网|二三中文)/;
/**
 * 夹在正文里的混淆贴片，例如 `\wＷｗ。 q Β5 .COM \．`（遮天玄幻阁版第 1 章）。
 * 只删这一段，同一行里的正文留着——整行丢掉会连「生命是世间最伟大的奇迹」一起丢。
 */
const AD_CHUNK = /[\\/][^\u4e00-\u9fa5]{0,24}?[.．]\s*(?:com|net|org|info|cn|us|la|me|cc)\b[^\u4e00-\u9fa5]{0,12}/gi;

/** 广告词（「网址」「请记住」这类）出现在行里就是广告行，多长都丢。 */
const AD_HARD = /(网址|请记住|牢记|记住我们|txt下载|手机阅读|本章未完|\bwww\b|https?:\/\/)/i;

/**
 * 硬广告词整行丢；短行里带「请认准/小说尽在」或站名也整行丢；
 * 剩下的先删贴片再看：删完几乎什么都不剩，那整行本来就是广告。
 */
function cleanLine(line) {
  if (AD_HARD.test(line)) return '';
  if (line.length < 60 && (AD.test(line) || SITE.test(line))) return '';
  const out = line.replace(AD_CHUNK, ' ').replace(/\s{2,}/g, ' ').trim();
  // 没删到东西就原样留着（「我认输。」这种短对白不是广告）；
  // 删完几乎什么都不剩，那整行本来就是贴片。
  return out === line || out.length >= 8 ? out : '';
}

/**
 * 洗正文：去站点广告、去行首全角缩进、合并多余空行。
 * 正文是模型要读的东西，宁可干净一点——一条广告会让她以为那是剧情。
 */
export function cleanText(raw) {
  const lines = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[\u3000\s]+/g, ' ').trim())
    .map(cleanLine)
    .filter(Boolean);
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

// ---- 读完一章之后：她自己的反应 ----
//
// 这一段的规矩：数字全由宿主给。模型只报「标签 + 1~3 的强度」，
// 让它自己报 v/a/d 的话每次都能报得不一样，情绪模型就散了。

/**
 * 七个标签——设计选择，不是实证。改它等于改性格，连测试一起改。
 * 爽 = 高愉悦高唤醒；触动 = 唤醒不高但浓度高；烦 = 有劲想吐槽，不是想哭。
 */
export const REACTIONS = {
  爽: { v: 0.85, a: 0.7, d: 0.65 },
  触动: { v: 0.62, a: 0.45, d: 0.42 },
  酸: { v: 0.36, a: 0.5, d: 0.3 },
  闷: { v: 0.28, a: 0.25, d: 0.35 },
  尬: { v: 0.25, a: 0.55, d: 0.35 },
  烦: { v: 0.16, a: 0.65, d: 0.48 },
  无感: null,
};
const INTENSITY = { 1: 0.3, 2: 0.5, 3: 0.75 };
const RE_MARK = /\[读\s*[:：]\s*(爽|触动|酸|闷|尬|烦|无感)\s*([1-3])?\s*(继续|敷衍|想弃)?\s*\]/;
const RE_ANY = /\[读[^\]]*\]/g;
// 模型在 maxTokens 处被切断时，尾巴是「[读」这种没闭合的残片（实测见过）。
// 它不是她的感想，剥掉——留在感想里，注入时就是一段看不懂的垃圾。
const RE_CUT = /\[读[^\]]*$/;

/** 去掉空白和标点再比：模型引原文时常顺手改标点。 */
const norm = (s) => String(s ?? '').replace(/[\s\u3000「」『』“”"'.,，。!！?？:：;；…—\-]/g, '');

/**
 * 感想里有没有真的引到原文：能对上「」里的引文就算；引不出来再看有没有连续 5 字重合
 * （4 字太容易撞「说道」「看着」这种）。两样都没有 = 无锚点。
 */
export function anchorOf(thought, chapterText = '') {
  const quoted = (String(thought ?? '').match(/「([^」]{3,})」/) || [])[1] || '';
  const text = norm(chapterText);
  if (quoted && text.includes(norm(quoted))) return quoted;
  const t = norm(thought);
  if (t.length < 5 || text.length < 5) return '';
  const grams = new Set();
  for (let i = 0; i + 5 <= text.length; i++) grams.add(text.slice(i, i + 5));
  for (let i = 0; i + 5 <= t.length; i++) if (grams.has(t.slice(i, i + 5))) return t.slice(i, i + 5);
  return '';
}

/**
 * 把模型写的那段话拆成：感想 + 标签 + 强度 + 去留 + 锚点。
 * 没写 `[读:…]` 或标签是「无感」= 没有情绪：感想照存（那是她的话），但不推情绪。
 */
export function parseReaction(reply, chapterText = '') {
  const raw = String(reply ?? '');
  const hit = RE_MARK.exec(raw);
  const stripped = raw.replace(RE_ANY, '').replace(RE_CUT, '').replace(/\s+/g, ' ').trim();
  const anchor = anchorOf(stripped, chapterText);
  return {
    thought: stripped.slice(0, 120),
    label: hit ? hit[1] : '无感',
    intensity: hit && hit[2] ? Number(hit[2]) : 0,
    want: hit && hit[3] ? hit[3] : '',
    anchor,
    anchored: Boolean(anchor),
  };
}

/** 标签 + 强度 → 给情绪引擎的那个事件。无锚点不算——引不出原文的反应多半是在演。 */
export function reactionEmotion(reaction) {
  if (!reaction || !reaction.anchored) return null;
  const base = REACTIONS[reaction.label];
  if (!base) return null;
  return { ...base, intensity: INTENSITY[reaction.intensity] ?? INTENSITY[2], label: reaction.label };
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
        // 哪个源：默认源是顶点小说，三本例外在玄幻阁（顶点版不分段/缺章）。查阅和日志都用它。
        origin: String(b?.originName || ''),
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

export const BORED_QUIET_MS = 30 * 60e3;    // 他安静这么久，她才开始无聊（2026-11-22 从 2 小时缩到半小时）
export const READ_GAP_MS = 10 * 60e3;       // 两章之间至少隔一次心跳，别在一个 tick 里连读
export const READS_PER_DAY = 80;            // 一天最多读这么多章（他定的）
export const READ_MAX_CHARS = 3000;         // 喂给模型的正文上限
export const READ_TITLES_KEEP = 60;         // 记住最近读过的标题：靠它躲开目录里的重复章
export const READING_EMOTION_DAY_MAX = 1.0; // 读书推给情绪引擎的强度，一天累计上限（80 章不能把心境钉死）
export const READ_SKIP_TRIES = 3;           // 连续遇到几个占位/坏章就这次不读了
export const PREFERRED_SOURCE = '顶点小说';  // 默认源（他定的）。只用来排序/记日志，不写死——三本例外在玄幻阁

/**
 * `[书:…]` 里那句「想看什么」。只认两种：目录，或者第 N 章。
 * @returns {{kind:'toc'}|{kind:'chapter', index:number}|null}
 */
export function parseBookLookup(spec) {
  const s = String(spec ?? '').trim();
  if (!s) return null;
  if (/目录|章节|更新|最新|到哪|多少章/.test(s)) return { kind: 'toc' };
  const m = /(\d{1,5})/.exec(s);
  if (m) return { kind: 'chapter', index: Math.max(0, Number(m[1]) - 1) };
  return null;
}

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

/**
 * 看完之后的进度。章号用来躲重复，标题用来躲缺章之后的重读。换书就重新开始算。
 * skipped=true 表示这一章是占位符/坏源（太短），只推进进度、不覆盖上一次的感想与标签。
 */
export function noteRead(state = {}, { now = 0, book = {}, index = 0, title = '', num = null, thought = '', label = '', intensity = 0, want = '', anchor = '', skipped = false } = {}) {
  const bookUrl = String(book.bookUrl || state.bookUrl || '');
  const sameBook = bookUrl === String(state.bookUrl || '');
  const keep = sameBook ? [String(title || '').trim(), ...(state.readTitles || [])] : [String(title || '').trim()];
  const pick = (fresh, old) => (skipped ? old : fresh);
  return {
    bookUrl,
    bookName: String(book.name || state.bookName || ''),
    index: Math.max(0, Math.round(Number(index) || 0)),
    title: String(title || ''),
    lastNum: Number.isFinite(Number(num)) ? Number(num) : (sameBook ? (state.lastNum ?? null) : null),
    readTitles: keep.filter(Boolean).slice(0, READ_TITLES_KEEP),
    thought: pick(String(thought || '').replace(/\s+/g, ' ').trim().slice(0, 120), String(state.thought || '')),
    // 上一章的标签和锚点：注入时用来看她「刚读完是什么滋味」，也给 P2 的态度账本当输入。
    label: pick(String(label || ''), String(state.label || '')),
    intensity: pick(Number.isFinite(Number(intensity)) ? Number(intensity) : 0, Number(state.intensity) || 0),
    want: pick(String(want || ''), String(state.want || '')),
    anchor: pick(String(anchor || ''), String(state.anchor || '')),
    skippedChapters: skipped ? (Number(state.skippedChapters) || 0) + 1 : 0,
    at: now,
  };
}

// 刚读完那一章的滋味，直接写进注入里——光有「想的是」没有「感觉是」，读起来还是像书评。
const READ_WORD = { 爽: '看得你挺爽', 触动: '看得你心里一动', 酸: '看得你心里发酸', 闷: '看得你有点闷', 尬: '看得你有点尬', 烦: '看得你有点烦' };

/** 注入给她的那一行。没有就不写——空块比假句子好。 */
export function novelLine(state, now = 0) {
  const name = String(state?.bookName || '').trim();
  const at = Number(state?.at) || 0;
  if (!name || !at) return '';
  const hours = Math.round((now - at) / 3600e3);
  const when = hours < 1 ? '刚才' : hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
  const where = state.title ? `第 ${Number(state.index) + 1} 章「${state.title}」` : `第 ${Number(state.index) + 1} 章`;
  const thought = String(state.thought || '').trim();
  // 只有 40 分钟内的才算「这会儿还带着的滋味」；过了就只剩「当时想的是」。
  const feel = now - at < 40 * 60e3 ? READ_WORD[state.label] : '';
  // 她写感想时常常整句引原文（开头就是「…」）；再套一层就变成「「…」」。
  const said = thought ? `，当时想的是：${thought.startsWith('「') ? thought : `「${thought}」`}` : '';
  return `你${when}自己在看《${name}》，读到${where}${feel ? `，${feel}` : ''}${said}。`;
}

// ---- P2：对一本书的态度会累积，并且有后果（弃书 / 追更 / 重读） ----
//
// 态度是「跨章」的东西：一章的滋味进情绪（分钟级），一本书的好坏感进 attitude（天级）。
// 没有这一层，「读多了会反感」就是个形容词——她只能每章都烦，永远烦不到弃书。

export const ATTITUDE_ALPHA = 0.15;        // 每章权重：最近几章算得多，但一章洗不白
export const DROP_ATTITUDE = -0.5;         // 态度跌破这条线就弃
export const DROP_STREAK = 5;              // 或者连烦 5 章
export const DROP_MIN_READS = 3;           // 前三章不判：开头难看很正常（偏念旧）
export const DROP_WANT = 2;                // 她连着两次说「想弃」= 主动放弃，比态度硬
export const REREAD_MIN_ATTITUDE = 0.3;    // 读完了值不值得再读一遍
const RECENT_KEEP = 5;                     // 每本书留最近几条反应：下一次反应要带上它

/** 一章的标签值多少态度分。无感也是消耗，只是很慢（−0.2 × 0.15 = 每章 −0.03）。 */
const ATTITUDE_DELTA = { 爽: 1, 触动: 0.8, 酸: 0.55, 闷: -0.3, 尬: -0.6, 烦: -1, 无感: -0.2 };

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * 读完一章，这本书在她心里涨了还是跌了。没锚点（label 空）不算账——那不是「无感」，是没读到。
 * @returns {object} 这本书的新记录（不碰 state）
 */
export function updateBook(prev = {}, { reaction = {}, title = '', now = 0 } = {}) {
  const label = String(reaction.label || '');
  const delta = ATTITUDE_DELTA[label];
  // 引不出原文（label 空）= 没有证据，态度原样留着。有标签才动账，无感也算
  // （EWMA 的 0 会把态度往基线拉，那等于没读到也会慢慢「洗白」一本书）。
  const attitude = delta === undefined
    ? (Number(prev.attitude) || 0)
    : round3((Number(prev.attitude) || 0) * (1 - ATTITUDE_ALPHA) + delta * ATTITUDE_ALPHA);
  const ugly = label === '尬' || label === '烦' || reaction.want === '想弃';
  const wants = reaction.want === '想弃';
  const entry = label ? {
    title: String(title || ''),
    label,
    intensity: Number(reaction.intensity) || 0,
    thought: String(reaction.thought || ''),
    anchor: String(reaction.anchor || ''),
    at: now,
  } : null;
  return {
    ...prev,
    reads: (Number(prev.reads) || 0) + 1,
    attitude,
    streak: ugly ? (Number(prev.streak) || 0) + 1 : 0,
    wantDrop: wants ? (Number(prev.wantDrop) || 0) + 1 : 0,
    lastLabel: label || String(prev.lastLabel || ''),
    lastAt: now,
    recent: entry ? [entry, ...(prev.recent || [])].slice(0, RECENT_KEEP) : (prev.recent || []),
  };
}

/** 该不该弃这本书。念旧体现在：前三章不判，态度线偏松，主动说「想弃」两次才认。 */
export function shouldDrop(book = {}) {
  if ((Number(book.reads) || 0) < DROP_MIN_READS) return false;
  if ((Number(book.wantDrop) || 0) >= DROP_WANT) return true;
  if ((Number(book.streak) || 0) >= DROP_STREAK) return true;
  return (Number(book.attitude) || 0) <= DROP_ATTITUDE;
}

/**
 * 下一次读哪本。一次只读一本，跟人一样。
 *
 * - continue：上次那本没读完
 * - reread：读完了但态度不错（同一本只重读一次）
 * - switch：换一本没读过的
 * - wait：全读完/全弃了——追更等着，不发模型调用
 * @returns {{kind:'continue'|'reread'|'switch'|'wait', book:object|null}}
 */
export function nextRead({ shelf = [], books = {}, state = {} } = {}) {
  // 0 章的多半是取目录失败（打开 App 刷新一次就好），不能当坏源，也不能白试一次。
  const list = (shelf || []).filter((b) => b?.bookUrl && Number(b.total) > 0);
  const rec = (b) => books[b.bookUrl] || {};
  const live = list.filter((b) => !rec(b).droppedAt);
  if (!live.length) return { kind: 'wait', book: null };
  const cur = state.bookUrl ? live.find((b) => b.bookUrl === state.bookUrl) : null;
  if (cur && !rec(cur).finishedAt) return { kind: 'continue', book: cur };
  if (cur) {
    const r = rec(cur);
    // 念旧：读完的书如果读得挺高兴，先重读一遍，而不是立刻换新的。
    if ((Number(r.attitude) || 0) >= REREAD_MIN_ATTITUDE && !r.reReadAt) return { kind: 'reread', book: cur };
  }
  // 上次那本弃了/没了：先找回一本没读完的（她读了一半的书不能白丢），再找没读过的。
  const open = live.find((b) => !rec(b).finishedAt && (Number(rec(b).reads) || 0) > 0);
  if (open) return { kind: 'switch', book: open };
  const unread = live.find((b) => !(Number(rec(b).reads) > 0));
  if (unread) return { kind: 'switch', book: unread };
  const reread = live
    .filter((b) => !rec(b).reReadAt && (Number(rec(b).attitude) || 0) >= REREAD_MIN_ATTITUDE)
    .sort((a, b) => (Number(rec(b).attitude) || 0) - (Number(rec(a).attitude) || 0))[0];
  return reread ? { kind: 'reread', book: reread } : { kind: 'wait', book: null };
}

/** 她最近几章的真实反应（新的在前）。反应 prompt 和「想一想」都从这里取材料。 */
export function recentReactions(state = {}, { since = 0, limit = 3 } = {}) {
  const out = [];
  for (const rec of Object.values(state.books || {})) {
    for (const r of rec?.recent || []) {
      const at = Number(r?.at) || 0;
      if (at < since) continue;
      out.push({
        book: String(rec.name || ''), title: String(r.title || ''), label: String(r.label || ''),
        intensity: Number(r.intensity) || 0, thought: String(r.thought || ''),
        anchor: String(r.anchor || ''), at,
      });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit));
}

// ---- P3：念头（每天最多一次「想一想」） ----

export const THOUGHT_KEEP = 20;
export const THOUGHT_TTL = 36 * 3600e3;   // 念头比感想活得久：它是「这两天在想」，不是「刚看完」

/** 最近一条念头。过期不注——「你这两天在想」隔了三天就是假话。 */
export function thoughtLine(state = {}, now = 0) {
  const list = state.thoughts || [];
  const last = list[list.length - 1];
  const text = String(last?.text || '').trim();
  const at = Number(last?.at) || 0;
  if (!text || !at || now - at > THOUGHT_TTL) return '';
  return `你这两天自己在想：「${text}」`;
}

/** 她对这本书的态度，占分量（|态度| ≥0.2）才说。 */
export function bookLine(state = {}) {
  const rec = (state.books || {})[state.bookUrl];
  const a = Number(rec?.attitude) || 0;
  const name = String(rec?.name || state.bookName || '').trim();
  if (!name || Math.abs(a) < 0.2) return '';
  const word = a >= 0.5 ? '挺喜欢这本' : a >= 0.2 ? '看得挺顺' : a <= -0.5 ? '快看不下去了' : '有点腻';
  return `你对《${name}》${word}。`;
}

/**
 * 每轮只注入一条读书相关的东西：念头 > 对书态度 > 读到哪。
 * 三条一起上，一轮就有三段「她在看书」，读起来像日志不像人。
 * @returns {{text:string, at:number, ttl:number}}
 */
export function mindLine(state = {}, now = 0) {
  const list = state.thoughts || [];
  const th = thoughtLine(state, now);
  if (th) return { text: th, at: Number(list[list.length - 1]?.at) || now, ttl: THOUGHT_TTL };
  const bl = bookLine(state);
  if (bl) return { text: bl, at: Number(state.at) || now, ttl: 12 * 3600e3 };
  return { text: novelLine(state, now), at: Number(state.at) || now, ttl: 12 * 3600e3 };
}

/** 记一条念头。空的不记——空着比硬凑好。 */
export function noteThought(state = {}, text = '', now = 0) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!t) return state;
  return { ...state, thoughts: [...(state.thoughts || []), { text: t, at: now }].slice(-THOUGHT_KEEP) };
}
