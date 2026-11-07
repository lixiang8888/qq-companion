// 查真事：Tavily 解析、来源、以及「一天内算新鲜」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { canSearch, cleanQuery, factLine, latestFact, noteSearch, search, sourcesLine, MAX_PER_DAY } from '../src/search.js';

const NOW = new Date(2026, 10, 7, 21, 0, 0).getTime();
const BODY = {
  answer: '湖州明天有雨，白天 18 度。',
  results: [
    { title: '湖州天气预报', url: 'https://www.weather.com.cn/weather/101210201.shtml', content: '明天小雨' },
    { title: '湖州天气', url: 'https://tianqi.so.com/weather/1', content: '转阴' },
  ],
};
const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('问题会被压平、截断，空的就报错', async () => {
  assert.equal(cleanQuery('  湖州\n明天  下雨吗  '), '湖州 明天 下雨吗');
  assert.equal(cleanQuery('あ'.repeat(200)).length, 80);
  await assert.rejects(search({ query: '   ', key: 'k' }), /没有要查的问题/);
});

test('没有密钥要明确报错，而不是静默', async () => {
  await assert.rejects(search({ query: '天气', key: '' }), /Tavily/);
});

test('正常搜索：拿回答、来源、时间', async () => {
  const f = await search({ query: '湖州明天天气', key: 'tvly-x', fetchImpl: ok(BODY), now: () => NOW });
  assert.match(f.answer, /有雨/);
  assert.equal(f.results.length, 2);
  assert.equal(f.at, NOW);
});

test('英文答案会让位给中文正文：她的上下文不该突然蹦出一句英文', async () => {
  const f = await search({
    query: '湖州天气',
    key: 'k',
    fetchImpl: ok({
      answer: 'It will be cloudy tomorrow.',
      results: [{ title: 't', url: 'https://a.cn/x', content: '明天多云，13 度。' }],
    }),
  });
  assert.match(f.answer, /多云/);
});

test('接口失败与空结果都抛错', async () => {
  await assert.rejects(search({ query: 'x', key: 'k', fetchImpl: async () => ({ ok: false, status: 432 }) }), /432/);
  await assert.rejects(search({ query: 'x', key: 'k', fetchImpl: ok({ answer: '', results: [] }) }), /空的/);
});

test('来源只留域名，去重、去 www', () => {
  const line = sourcesLine([
    { url: 'https://www.weather.com.cn/a' },
    { url: 'https://weather.com.cn/b' },
    { url: 'https://tianqi.so.com/c' },
    { url: '不是链接' },
  ]);
  assert.equal(line, 'weather.com.cn、tianqi.so.com');
});

test('那一行必须写明「网上这么说」，不能让她当成自己看见的', () => {
  const line = factLine({ at: NOW, query: '湖州明天天气', answer: '有雨', results: [{ url: 'https://a.cn/x' }] });
  assert.match(line, /网上这么说/);
  assert.match(line, /来源：a\.cn/);
  assert.match(line, /湖州明天天气/);
  assert.equal(factLine({}), '');
});

test('每天的次数上限与新鲜度', () => {
  let s = {};
  assert.equal(canSearch(s, NOW), true);
  for (let i = 0; i < MAX_PER_DAY; i += 1) s = noteSearch(s, { now: NOW, fact: { at: NOW, query: `q${i}`, answer: 'a' } });
  assert.equal(canSearch(s, NOW), false);
  assert.equal(canSearch(s, NOW + 24 * 3600e3), true, '换天就重新算');
  assert.equal(s.items.length, MAX_PER_DAY > 5 ? 5 : MAX_PER_DAY);
});

test('昨天查的不算新鲜：不能拿旧消息说今天的话', () => {
  const s = noteSearch({}, { now: NOW, fact: { at: NOW, query: 'q', answer: 'a' } });
  assert.ok(latestFact(s, NOW));
  assert.equal(latestFact(s, NOW + 25 * 3600e3), null);
});
