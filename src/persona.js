// 人格卡分层 + 这一轮是什么场合 + 「她绕回来了」。
//
// 为什么拆三层：人格卡以前是一整段文本、无条件注入，同时承担三件本来不同的事——
// 「我是谁」（不能变）、「默认怎么说」（该能被情境覆盖）、「这种场合怎么办」（该按场景出现）。
// 三层压成一份，第二层就被当成了第一层：她拒绝扮妈妈不是判断了越权，
// 而是角色卡里没写能演，她把「没说」当成了「不能」。
//
// 边界：这里只做切分和拼装，不改一个字。老的人格卡（没有任何标记）整份当内核，
// 行为和以前完全一样——这是回滚保险。

export const MARK_CORE = '## 内核';
export const MARK_STYLE = '## 风格默认';
export const MARK_SITUATION = '## 情境';

/** 情境标题怎么归类。也支持直接写 `### long` 这种 key 名。 */
const TITLE_RULES = [
  ['long', /长|故事|展开|讲讲|说说/],
  ['soothe', /低落|认真|难受|难过|安慰/],
  ['play', /语气|扮演|演|假装|装/],
  ['night', /深夜|凌晨|夜|睡/],
];

/** 这一轮的话命中了哪些场合。关键词只影响拼哪几行，不影响别的。 */
export const SITUATION_RULES = [
  ['long', /讲讲|说说|讲个|讲一段|故事|详细|展开|多讲|细说|从头说/],
  ['soothe', /哄|睡不着|失眠|安慰|抱抱|陪我睡|想哭|难受/],
  ['play', /装作|扮演|假装|模仿|换个语气|换个调子|用.{0,8}语气|学.{0,8}(语气|说话|讲话)|装(?!什么|啥|作|得)/],
];

const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n');

/**
 * 把人格卡切成三段。没有标记 → 整份当内核。
 * @returns {{marked:boolean, core:string, style:string, situations:{key:string,title:string,body:string}[]}}
 */
export function splitPersona(text) {
  const raw = norm(text);
  const lines = raw.split('\n');
  const at = { core: -1, style: -1, situation: -1 };
  lines.forEach((line, i) => {
    const s = line.trim();
    if (s === MARK_CORE) at.core = i;
    else if (s === MARK_STYLE) at.style = i;
    else if (s === MARK_SITUATION) at.situation = i;
  });
  const found = Object.entries(at).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  if (!found.length) return { marked: false, core: raw.trim(), style: '', situations: [] };

  const part = {};
  found.forEach(([key, start], k) => {
    const end = k + 1 < found.length ? found[k + 1][1] : lines.length;
    part[key] = lines.slice(start + 1, end).join('\n').trim();
  });

  const situations = [];
  let cur = null;
  for (const line of (part.situation || '').split('\n')) {
    const s = line.trim();
    if (/^###\s+/.test(s)) {
      cur = { title: s.replace(/^###\s+/, '').trim(), body: '' };
      situations.push(cur);
    } else if (cur) cur.body += `${line}\n`;
  }
  return {
    marked: true,
    core: (part.core || '').trim(),
    style: (part.style || '').trim(),
    situations: situations
      .map((s) => ({ key: keyOf(s.title), title: s.title, body: s.body.trim() }))
      .filter((s) => s.body),
  };
}

/**
 * 标题 → 场合 key。认不出来（且标题不是 key 名）就是 null，那份情境永不注入。
 * shortcut: 靠标题关键词归类，标题写得太文艺就认不出来；那时直接把标题改成 `### long`。
 */
function keyOf(title) {
  const t = String(title || '');
  if (SITUATION_RULES.some(([k]) => k === t) || t === 'night') return t;
  for (const [key, re] of TITLE_RULES) if (re.test(t)) return key;
  return null;
}

/**
 * 注入 system 的那部分：只要内核 + 风格默认。情境按这一轮另外拼，
 * 因为它随「他说了什么、现在几点」变，而 system 是每轮重算但不该随单句话摆动的东西。
 */
export function systemPersona(text) {
  const p = splitPersona(text);
  if (!p.marked) return p.core;
  return [p.core, p.style].filter(Boolean).join('\n\n');
}

/** 这一轮命中哪些场合。`night` 只看本机时间，不看他说了什么。 */
export function situationsFor(text, { at } = {}) {
  const hits = [];
  for (const [key, re] of SITUATION_RULES) if (re.test(String(text || ''))) hits.push(key);
  const t = at == null ? Date.now() : Number(at);
  const h = new Date(t).getHours();
  if (h >= 23 || h <= 4) hits.push('night');
  return hits;
}

/** 把命中的情境拼成 context 里的一段。没命中就返回空串。 */
export function situationText(persona, keys = []) {
  const want = new Set(keys || []);
  if (!want.size) return '';
  const p = splitPersona(persona);
  const lines = p.situations.filter((s) => s.key && want.has(s.key)).map((s) => `· ${s.body}`);
  if (!lines.length) return '';
  return `【这一轮的场合】（这一轮是这种场合，按这里说的来；它不是新规矩，是这个场合下的默认）\n${lines.join('\n')}`;
}

// 太短的话不参与判断：「好」「嗯」「？」「在吗」本来就会重复，而且它们不算「在说同一件事」。
const STUCK_MIN_CHARS = 3;
const STUCK_NEED = 3;
export const STUCK_SIMILAR = 0.6;

export const STUCK_LINE = '【你已经绕回来了】上两轮你在说同一件事。换个说法，或者换个话题；也可以直接问他为什么还在提这个。';

/** 她的短回复比对用字符集，不用 2-gram：句子太短，2-gram 会把「去睡吧」「快去睡吧」判成两条。 */
const charsOf = (s) => new Set(String(s).replace(/[\s\p{P}\p{S}]/gu, ''));

/**
 * 她最近几条回复是不是在说同一件事。
 *
 * 判据刻意选「她自己的回复彼此相似」，不是「新回复像不像旧回复」：
 * 后者会被口头禅和正常接话误伤，前者才是真的在原地打转——
 * 催睡、反复道歉、反复追问、「行吧」、「我在」，都是这个形状。
 */
export function looksStuck(replies = [], { threshold = STUCK_SIMILAR } = {}) {
  const rs = (replies || [])
    .map((r) => String(r ?? '').trim())
    .filter((r) => r.length >= STUCK_MIN_CHARS)
    .slice(-STUCK_NEED);
  if (rs.length < STUCK_NEED) return false;
  const sets = rs.map(charsOf);
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      if (!sets[i].size || !sets[j].size) return false;
      let hit = 0;
      for (const c of sets[i]) if (sets[j].has(c)) hit += 1;
      // 除以较短的那条：短的那句被长的那句包住，也是同一件事。
      if (hit / Math.min(sets[i].size, sets[j].size) < threshold) return false;
    }
  }
  return true;
}
