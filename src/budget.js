// token 饭：她今天说了多少话、用了多少 token，以及家里还剩多少钱。
//
// 两个数字来源不同，绝不混成一个：
//   - token：每次模型调用末尾的 `usage` 块（DSH 协议里 usage 先于 finish；
//     字段是 inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens，
//     取自 dsh-token-meter 自己的投影代码，不是猜的）。
//   - 钱：DeepSeek 官方 GET /user/balance。那是账户余额，**不等于她一个人的花销**——
//     你在这台机器上用 DSH 也在花同一个账户的钱。
// 所以这里没有「每千 token 多少钱」的单价表：编一个出来，她说出口的每个数字就都是假的。

import { dayKey } from './diary.js';

export const BALANCE_URL = 'https://api.deepseek.com/user/balance';
export const LOW_BALANCE_CNY = 5;

export function createBudget(now = 0) {
  return { day: dayKey(now), calls: 0, input: 0, output: 0, cached: 0, balance: null };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 归一化一次调用的用量。形状不认识就返回 null——宁可没有数字，不要假数字。 */
export function usageOf(chunk) {
  const u = chunk?.usage ?? chunk;
  if (!u || typeof u !== 'object') return null;
  const input = num(u.inputTokens ?? u.uncachedInputTokens);
  const output = num(u.outputTokens);
  const cached = num(u.cacheReadTokens) + num(u.cacheWriteTokens);
  if (!input && !output && !cached) return null;
  return { input, output, cached };
}

/** 记账。跨本地日就归零（不是按 UTC）。 */
export function addUsage(budget, usage, now = 0) {
  const day = dayKey(now);
  const base = budget?.day === day ? budget : { ...createBudget(now), balance: budget?.balance ?? null };
  if (!usage) return base;
  return {
    ...base,
    day,
    calls: base.calls + 1,
    input: base.input + usage.input,
    output: base.output + usage.output,
    cached: base.cached + usage.cached,
  };
}

export function fmtTokens(n) {
  const v = num(n);
  if (v >= 10000) return `${Math.round(v / 1000) / 10} 万`;
  return String(Math.round(v));
}

export function spendLine(budget) {
  if (!budget?.calls) return '';
  return `今天你说了 ${budget.calls} 次话，用了 ${fmtTokens(budget.input + budget.output + budget.cached)} token`;
}

/** 余额那半句。查不到（401/断网/没 key）就返回空串——不拿旧数字接着用。 */
export function balanceLine(balance, { low = LOW_BALANCE_CNY } = {}) {
  if (!balance?.ok || !Number.isFinite(balance.total)) return '';
  return balance.total < low ? `家里只剩 ${balance.total.toFixed(2)} 元` : `家里还剩 ${balance.total.toFixed(2)} 元`;
}

/** 给她的一段。一条真数字都没有时返回空串。 */
export function moneyBlock(budget, { low } = {}) {
  const parts = [spendLine(budget), balanceLine(budget?.balance, { low })].filter(Boolean);
  if (!parts.length) return '';
  return `【钱】${parts.join('；')}。（钱是账户的，不全是你花的；他问起才说，别主动提，更别报账。）`;
}

/**
 * 查余额。任何失败都只返回 {ok:false}，绝不抛：额度、网络、key 类型（第三方中转会 401）
 * 都不该把她弄哑。返回里不带 key。
 * @param {{resolveKey?: (ref: string) => Promise<any>, fetchImpl?: Function, url?: string, now?: number, timeoutMs?: number}} o
 */
export async function fetchBalance({ resolveKey, fetchImpl = globalThis.fetch, url = BALANCE_URL, now = 0, timeoutMs = 8000 } = {}) {
  try {
    const got = await resolveKey?.('DEEPSEEK_API_KEY');
    const key = typeof got === 'string' ? got : got?.value;
    if (!key) return { ok: false, reason: '没有 DEEPSEEK_API_KEY', at: now };
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res?.ok) return { ok: false, reason: `HTTP ${res?.status ?? '?'}`, at: now };
    const body = await res.json();
    const info = (body?.balance_infos || [])[0];
    const total = Number(info?.total_balance);
    if (!Number.isFinite(total)) return { ok: false, reason: '返回里没有余额', at: now };
    return { ok: true, total, currency: info.currency || 'CNY', at: now };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), at: now };
  }
}
