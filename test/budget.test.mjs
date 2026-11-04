// token 饭：钱和 token 是两个来源，不能混成一个数。
//   - token：每次模型调用末尾的 usage 块（DSH 协议，usage 先于 finish）
//   - 钱：DeepSeek 官方 /user/balance，是账户的余额，不是她一个人的花销
// 插件不编单价，所以这里没有任何「每千 token 多少钱」的假数字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, balanceLine, createBudget, fetchBalance, fmtTokens, moneyBlock, spendLine, usageOf } from '../src/budget.js';

const at = (d, h = 0) => new Date(2026, 9, d, h, 0, 0).getTime();

test('读 usage：字段名照 DSH 协议，缓存读写也算进总量', () => {
  assert.deepEqual(usageOf({ inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900, cacheWriteTokens: 100 }), { input: 1200, output: 80, cached: 1000 });
  assert.deepEqual(usageOf({ usage: { inputTokens: 5, outputTokens: 1 } }), { input: 5, output: 1, cached: 0 });
});

test('形状不对就不记账：宁可没有数字，不要假数字', () => {
  for (const bad of [null, {}, { usage: {} }, { inputTokens: 'x' }, 42]) {
    assert.equal(usageOf(bad), null, `不该记：${JSON.stringify(bad)}`);
  }
});

test('跨本地日归零，不是按 UTC', () => {
  const justBefore = addUsage(createBudget(at(28, 23)), { input: 10, output: 2, cached: 0 }, at(28, 23, 59));
  assert.equal(justBefore.calls, 1);
  const afterMidnight = addUsage(justBefore, { input: 10, output: 2, cached: 0 }, at(29, 0, 30));
  assert.equal(afterMidnight.day, '2026-10-29');
  assert.equal(afterMidnight.calls, 1, '新的一天从 1 次算起');
  assert.equal(afterMidnight.input, 10);
});

test('累加：次数、输入、输出、缓存，余额不动', () => {
  const bal = { ok: true, total: 13.23, currency: 'CNY', at: at(28, 20) };
  let b = { ...createBudget(at(28, 9)), balance: bal };
  b = addUsage(b, { input: 100, output: 20, cached: 50 }, at(28, 10));
  b = addUsage(b, { input: 300, output: 40, cached: 0 }, at(28, 11));
  assert.equal(b.calls, 2);
  assert.equal(b.input, 400);
  assert.equal(b.output, 60);
  assert.equal(b.cached, 50);
  assert.equal(b.balance, bal, '记账不能把余额冲掉');
});

test('token 数说得像人话', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(940), '940');
  assert.equal(fmtTokens(83000), '8.3 万');
});

test('钱的一句：只报查到的真数字，查不到就不说钱', () => {
  assert.equal(balanceLine(null), '');
  assert.equal(balanceLine({ ok: false, reason: 'HTTP 401' }), '');
  assert.match(balanceLine({ ok: true, total: 13.23 }), /13\.23 元/);
  assert.match(balanceLine({ ok: true, total: 3 }), /只剩/);
});

test('给她的一段：有 token 有余额；余额查不到就只说 token', () => {
  const b = addUsage(createBudget(at(28, 9)), { input: 80000, output: 3000, cached: 0 }, at(28, 10));
  const withMoney = moneyBlock({ ...b, balance: { ok: true, total: 13.23 } });
  assert.match(withMoney, /1 次/);
  assert.match(withMoney, /8\.3 万/);
  assert.match(withMoney, /13\.23 元/);
  assert.match(withMoney, /别主动提/, '钱要能说，但不能变成每分钟的记账员');

  const noMoney = moneyBlock({ ...b, balance: { ok: false, reason: 'HTTP 401' } });
  assert.match(noMoney, /8\.3 万/);
  assert.doesNotMatch(noMoney, /元/);
});

test('一次话都没说过：不写占位句', () => {
  assert.equal(spendLine(createBudget(at(28, 9))), '');
  assert.equal(moneyBlock(createBudget(at(28, 9))), '');
});

test('查余额：200 读出真数，401 就是查不到，绝不抛', async () => {
  const ok = await fetchBalance({
    resolveKey: async () => ({ value: 'sk-test' }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '13.23', granted_balance: '0.00', topped_up_balance: '13.23' }] }),
    }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.total, 13.23);
  assert.equal(ok.currency, 'CNY');

  const denied = await fetchBalance({ resolveKey: async () => ({ value: 'sk-test' }), fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /401/);

  const noKey = await fetchBalance({ resolveKey: async () => undefined, fetchImpl: async () => { throw new Error('不该被调用'); } });
  assert.equal(noKey.ok, false);

  const boom = await fetchBalance({ resolveKey: async () => ({ value: 'sk-test' }), fetchImpl: async () => { throw new Error('断网'); } });
  assert.equal(boom.ok, false);
});

test('查余额失败时，key 不会漏进结果里', async () => {
  const key = 'sk-very-secret-value';
  const r = await fetchBalance({ resolveKey: async () => ({ value: key }), fetchImpl: async () => { throw new Error('断网'); } });
  assert.equal(JSON.stringify(r).includes(key), false);
});
