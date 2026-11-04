// 真机验证：插件接口通不通，以及「通了但网关没连」该怎么读。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPanel, verdict } from '../src/live-check.js';

const okBody = {
  ok: true, gateway: 'connected', line: '心情平常 · 信任 0.50', persona: '小鲸鱼',
  memoryStats: { total: 12 }, session: { size: 34 },
};

test('通了：带回网关、记忆、会话', async () => {
  const r = await checkPanel({ fetchImpl: async (url) => { assert.match(url, /\/qq-companion\/api\/state$/); return { ok: true, json: async () => okBody }; } });
  assert.equal(r.ok, true);
  assert.equal(r.gateway, 'connected');
  assert.equal(r.memory, 12);
  assert.equal(r.session, 34);
  assert.match(verdict(r), /已连上/);
});

test('404：说明没装或没重启', async () => {
  const r = await checkPanel({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /HTTP 404/);
  assert.match(verdict(r), /没连上/);
});

test('连不上：报原因，不抛', async () => {
  const r = await checkPanel({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(r.ok, false);
  assert.match(r.detail, /ECONNREFUSED/);
});

test('通了但网关在重连：指出该查 SnowLuma', async () => {
  const r = await checkPanel({ fetchImpl: async () => ({ ok: true, json: async () => ({ ...okBody, gateway: 'reconnecting' }) }) });
  assert.match(verdict(r), /SnowLuma/);
});

test('通了但网关停着：指出检查 enabled 与 wsUrl', async () => {
  const r = await checkPanel({ fetchImpl: async () => ({ ok: true, json: async () => ({ ...okBody, gateway: 'stopped' }) }) });
  assert.match(verdict(r), /enabled/);
});
