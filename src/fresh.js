// 「关于现在」的文本怎么进上下文。
//
// 这一类错误长一个样：一句话在某一刻生成，之后每轮重放，而它的「现在」早就过期了。
// 本项目已经犯过两次（人格叙事说「我最近…」、周自述说「你最近的想法」），
// 也做对过三次（此刻在干什么绑 until、天气标注查的时间、翻到的原话带时间戳且只活一轮）。
// 规矩一直是知道的，只是没有地方强制它。
//
// 所以这里只有一条规矩，用 API 表达：
//   **每一块上下文都要说自己生于何时、能活多久。**
// 生于此刻、每轮现算的块天然安全（at = now）；凡是 at 早于现在的块，必须给 ttl，
// 否则拼装时直接抛——不是警告，是抛。这样「永久挂上去」只能是一个打字的决定，不可能是默认。
//
// 它挡不住的是「生成方撒谎」：写代码的人永远可以传 at = now 蒙混过去。
// 那一半由 test/context-aging.test.mjs 挡：把时钟拨到一年后，看剩下的东西会不会撒谎。

export const MINUTE = 60e3;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * 一块上下文。
 * @param {string} key 名字，报错时要能一眼看出是哪一块
 * @param {string} text 内容；空串表示这一轮没有这块
 * @param {number} at 这段内容是**哪一刻生成的**（不是它描述的事件发生在哪一刻）
 * @param {number} [ttl] 能活多久；at 早于现在就不许省
 */
export function blk(key, text, at, ttl) {
  if (!text) return null;
  const born = Number(at);
  if (!Number.isFinite(born)) throw new Error(`上下文块「${key}」没说自己生于何时（at）`);
  return { key, text: String(text), at: born, ttl: ttl == null ? 0 : Number(ttl) };
}

/**
 * 拼成一段。过期的丢掉；没说 ttl 又不是本轮生成的就抛。
 * @throws 当某个块 was born earlier 却没有 ttl
 */
export function assemble(blocks = [], { now } = {}) {
  const t = Number(now);
  if (!Number.isFinite(t)) throw new Error('assemble 需要 now');
  const out = [];
  for (const b of blocks) {
    if (!b) continue;
    if (!Number.isFinite(b.at)) throw new Error(`上下文块「${b.key}」没说自己生于何时（at）`);
    const expired = b.ttl > 0 && t - b.at >= b.ttl;
    if (expired) continue;
    // at 早于现在 = 这是以前生成的东西。那它就得交代自己能活多久。
    if (b.at < t && !(b.ttl > 0)) {
      throw new Error(`上下文块「${b.key}」是 ${Math.round((t - b.at) / 1000)} 秒前生成的，却没说能活多久（ttl）`);
    }
    out.push(b.text);
  }
  return out.filter(Boolean).join('\n');
}
