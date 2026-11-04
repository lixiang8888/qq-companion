// 自检：装好之后靠它判断「哪一步没通」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pingOneBot, preflight } from '../src/preflight.js';
import { initState } from '../src/affect/core.js';
import { createCard, remember } from '../src/memory/card.js';

const dir = () => mkdtempSync(join(tmpdir(), 'qqc-pre-'));

function seeded() {
  const d = dir();
  writeFileSync(join(d, 'config.json'), JSON.stringify({
    ownerQQ: '10001',
    onebot: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3001', token: 'T' },
  }));
  mkdirSync(join(d, 'personas'));
  writeFileSync(join(d, 'personas', '小鲸鱼.md'), '# 小鲸鱼');
  writeFileSync(join(d, 'affect.json'), JSON.stringify(initState(0)));
  writeFileSync(join(d, 'memory.json'), JSON.stringify(remember(createCard(0), '他喜欢猫', { now: 0 })));
  return d;
}

test('齐全时全部通过，并报出记忆条数', () => {
  const r = preflight({ dataDir: seeded() });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  const mem = r.checks.find((c) => c.name === '记忆卡');
  assert.match(mem.detail, /1 条记忆/);
});

test('没配置：明确指出缺什么，不假装通过', () => {
  const r = preflight({ dataDir: dir() });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === '配置存在').ok, false);
  assert.equal(r.checks.find((c) => c.name === 'ownerQQ 已设置').ok, false);
});

test('还没写过人格卡：不算失败（启动时会自动写一份）', () => {
  const d = dir();
  writeFileSync(join(d, 'config.json'), JSON.stringify({
    ownerQQ: '10001',
    onebot: { wsUrl: 'ws://x', httpUrl: 'http://x', token: 'T' },
  }));
  const r = preflight({ dataDir: d });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  const c = r.checks.find((x) => x.name === '人格卡');
  assert.equal(c.ok, true);
  assert.match(c.detail, /自动写入/);
});

test('ownerQQ 没填时只显示后四位以外的信息，不泄露全号', () => {
  const d = seeded();
  writeFileSync(join(d, 'config.json'), JSON.stringify({ ownerQQ: '10001', onebot: { wsUrl: 'w', httpUrl: 'h' } }));
  const r = preflight({ dataDir: d });
  const c = r.checks.find((x) => x.name === 'ownerQQ 已设置');
  assert.equal(c.ok, true);
  assert.ok(!c.detail.includes('10001'), `回显了完整 QQ：${c.detail}`);
});

test('坏数据文件：报读坏了，不崩', () => {
  const d = seeded();
  writeFileSync(join(d, 'memory.json'), '{ broken');
  const r = preflight({ dataDir: d });
  assert.equal(r.checks.find((c) => c.name === '记忆卡').ok, false);
});

test('OneBot 探测：成功时带登录号，失败时给原因', async () => {
  const ok = await pingOneBot({ httpUrl: 'http://x' }, async () => ({ ok: true, json: async () => ({ data: { user_id: 12345 } }) }));
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /12345/);

  const bad = await pingOneBot({ httpUrl: 'http://x' }, async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /ECONNREFUSED/);
});
