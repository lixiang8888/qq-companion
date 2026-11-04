// 记忆的按需检索：中文二元切词 + BM25-lite。
//
// 为什么不用 SQLite FTS5：本机实测 unicode61 不切中文（`今天` 搜不到 `今天很开心`），
// 与其绕，不如自己做二十行切词。几千条以内毫秒级，和参考实现的做法一致。
//
// 打分口径：BM25 × 重要度 × 清晰度 × 新近。乘而不是加，是为了让「不重要又模糊」的记录
// 即使字面命中也不会挤掉「重要且清楚」的。

const STOP = new Set('的了是我你他她它们在有和就不也都很吗吧呢啊呀哦嗯这那个一上下来去说要会能着过'.split(''));

/** 切词：英文/数字整词；中文连续段拆成二元字组（单字去掉停用字）。 */
export function tokenize(text) {
  const out = [];
  const s = String(text || '').toLowerCase();
  for (const m of s.matchAll(/[a-z0-9_]{2,}|[\u4e00-\u9fff]+/g)) {
    const w = m[0];
    if (/^[a-z0-9_]+$/.test(w)) { out.push(w); continue; }
    if (w.length === 1) { if (!STOP.has(w)) out.push(w); continue; }
    for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
  }
  return out;
}

export function buildIndex(records) {
  const df = new Map();
  const docs = records.map((r) => {
    const toks = tokenize(`${r.text}`);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { rec: r, tf, len: toks.length || 1 };
  });
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1);
  return { docs, df, avgLen, N: docs.length };
}

const CLARITY_WEIGHT = { vivid: 1, clear: 0.8, fuzzy: 0.5, trace: 0.2 };

/**
 * @param {{text: string}[]} records
 * @param {string} query
 * @param {{now?: number, limit?: number}} [o]
 */
export function search(records, query, { now = Date.now(), limit = 6 } = {}) {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !records.length) return [];
  const idx = buildIndex(records);
  const k1 = 1.4;
  const b = 0.7;
  const scored = [];
  for (const d of idx.docs) {
    let bm25 = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = idx.df.get(t) || 0;
      const idf = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
      bm25 += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / idx.avgLen));
    }
    if (bm25 <= 0) continue;
    const r = d.rec;
    const days = Math.max(0, (now - (r.lastSeenAt || now)) / 86400e3);
    const recency = 0.7 + 0.3 * Math.exp(-days / 30);
    const score = bm25 * (0.5 + 0.5 * ((r.importance || 50) / 100)) * (CLARITY_WEIGHT[r.clarity] || 0.5) * recency;
    scored.push({ rec: r, score });
  }
  return scored.sort((a, b2) => b2.score - a.score).slice(0, limit);
}
