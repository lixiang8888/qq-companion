// 查真事：Tavily 一次搜索，带来源。
//
// 这条只回答「网上怎么说」——不是观测值，也不保证是对的。
// 所以天气不走这里（见 weather.js），而且查回来的东西必须带「网上这么说」的框。
//
// 它只有一个入口：她自己在心里嘀咕的时候（proactive 的决策 JSON 里那个 search 键）。
// 不给她一个「随时能查」的按钮，是因为她本来就没有人随时替她查东西的习惯。

import { dayKeyOf } from './affect/core.js';

export const TAVILY_URL = 'https://api.tavily.com/search';
export const MAX_QUERY = 80;
export const MAX_PER_DAY = 5;
export const KEEP_FACTS = 5;
// 查回来的事只在一天内算新鲜：昨天的新闻摆在她眼前只会让她说错话。
export const FACT_TTL_MS = 24 * 3600e3;

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const CJK = /[\u4e00-\u9fa5]/;

/**
 * 取哪段话。Tavily 的 answer 有时是英文的（哪怕问的是中文），
 * 那种句子塞进她的上下文里格格不入——优先要中文，实在没有才用它。
 */
function pickAnswer(body) {
  const answer = String(body.answer || '').trim();
  if (answer && CJK.test(answer)) return answer;
  const zh = (body.results || [])
    .map((r) => String(r.content || '').trim())
    .find((c) => c && CJK.test(c));
  return zh || answer;
}

export function cleanQuery(q) {
  return String(q || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
}

export async function search({ query, key, fetchImpl = globalThis.fetch, maxResults = 3, timeoutMs = 25000, now = Date.now } = {}) {
  const q = cleanQuery(query);
  if (!q) throw new Error('没有要查的问题');
  if (!key) throw new Error('没有配 Tavily 密钥（config.search.key）');
  const res = await fetchImpl(TAVILY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, max_results: maxResults, include_answer: true, search_depth: 'basic' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res?.ok) throw new Error(`搜索 HTTP ${res?.status}`);
  const body = await res.json().catch(() => null);
  if (!body) throw new Error('搜索返回的不是 JSON');
  const answer = pickAnswer(body);
  const results = (body.results || [])
    .map((r) => ({ title: String(r.title || '').slice(0, 80), url: String(r.url || ''), content: String(r.content || '').slice(0, 300) }))
    .filter((r) => r.url);
  if (!answer && !results.length) throw new Error('搜到的是空的');
  return { at: now(), query: q, answer: answer || results[0].content, results };
}

/** 来源只要域名：长 URL 进提示词既占地方又像乱码。 */
export function sourcesLine(results = [], max = 2) {
  const hosts = [];
  for (const r of results) {
    try {
      const h = new URL(r.url).hostname.replace(/^www\./, '');
      if (!hosts.includes(h)) hosts.push(h);
    } catch { /* 坏链接不要 */ }
    if (hosts.length >= max) break;
  }
  return hosts.join('、');
}

/** 查回来这件事，拼成她上下文里的一行。带「网上这么说」——不是她亲眼看见的。 */
export function factLine(fact) {
  if (!fact?.query || !fact.answer) return '';
  const src = sourcesLine(fact.results);
  const said = String(fact.answer).replace(/\s+/g, ' ').slice(0, 160);
  return `你查过一件事：「${fact.query}」→ ${said}${src ? `（网上这么说，来源：${src}）` : '（网上这么说）'}`;
}

/**
 * 「想了解一件事」要的是材料，不是结论。
 *
 * factLine 把一切压成一句——那是「他想知道一个数」的形状。她说「我查一下」的时候，
 * 压成一句就是替她总结了，她只能把那句转述出去。所以这里给 2~3 条带来源的要点，
 * 让她自己组织语言。
 */
export function materialLines(fact, { max = 3, maxChars = 120 } = {}) {
  if (!fact?.query) return '';
  const items = (fact.results || [])
    .slice(0, max)
    .map((r) => String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, maxChars))
    .filter(Boolean);
  const bullet = items.length ? items : [String(fact.answer || '').replace(/\s+/g, ' ').trim().slice(0, maxChars)].filter(Boolean);
  if (!bullet.length) return '';
  const src = sourcesLine(fact.results, 3);
  return `【你刚查到的】（网上这么说，不是他说的；来源：${src || '未知'}）\n${bullet.map((b) => `- ${b}`).join('\n')}`;
}

export function canSearch(state = {}, now = Date.now(), cap = MAX_PER_DAY) {
  return (state?.day === dayKeyOf(now) ? num(state.n, 0) : 0) < cap;
}

export function noteSearch(state = {}, { now = Date.now(), fact } = {}) {
  const day = dayKeyOf(now);
  return {
    ...state,
    day,
    n: (state?.day === day ? num(state.n, 0) : 0) + 1,
    items: fact ? [fact, ...(state?.items || [])].slice(0, KEEP_FACTS) : (state?.items || []).slice(0, KEEP_FACTS),
  };
}

/** 最近一条还算新鲜的事；过了一天就当没查过。 */
export function latestFact(state = {}, now = Date.now(), ttl = FACT_TTL_MS) {
  return (state?.items || []).find((f) => f?.at && now - f.at < ttl) || null;
}
