// 他连着问了两件事，她只答一件——另一件不能就这么消失。
//
// 判定只用标点和疑问词，不问模型：问号是硬的，「吗/什么/怎么/为什么」也是硬的。
// 一次最多挂两条：挂太多，她就变成在追着回旧账。

/** 一句话算不算提问。 */
export function looksLikeQuestion(sentence) {
  const s = String(sentence || '').trim();
  if (!s) return false;
  if (/[?？]\s*$/.test(s)) return true;
  return /(吗|呢|什么|怎么|为什么|哪|谁|多少|几点|是不是|能不能)\s*$/.test(s);
}

/** 把一段话拆成句子，挑出提问（保持原顺序）。断句时保留标点，否则「几点睡的？」会认不出来。 */
export function extractQuestions(text, max = 4) {
  const parts = String(text || '')
    .split(/(?<=[。！!？?\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (looksLikeQuestion(p)) out.push(p.replace(/[?？]\s*$/, '').trim());
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 这一轮结束后，哪些问题该挂到下一轮。
 * 只挂「前面那些」——最后一条通常是她刚要答的。
 */
export function leftoverQuestions(questions) {
  const list = (questions || []).filter(Boolean);
  if (list.length <= 1) return [];
  return list.slice(0, -1).slice(0, 2);
}

/** 注入用的那一行。没有挂起的问题就返回空串（不占提示词）。 */
export function pendingLine(pending) {
  const list = (pending || []).filter(Boolean);
  if (!list.length) return '';
  return `[他之前问过、你还没答的：${list.join('；')}。先答这个，别装没看见]`;
}
