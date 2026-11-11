// 时间旅行守卫：同一个状态文件、没有任何新事件，只把时钟往前拨。
//
// 这一类错误长一个样：一句话在某个时刻生成，之后每轮重放，而它的「现在」早就过期了。
// 已经犯过两次（人格叙事说「我最近…」、周自述说「你最近的想法」），
// 也做对过（此刻在干什么绑 until、天气标查的时间、翻到的原话带时间戳且只活一轮）。
//
// 所以这条测试不针对某一个字段，它针对整段上下文：
// **把时钟拨到一年后，任何「现在/最近/此刻」的说法都不许留下。**
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.js';
import { initState } from '../src/affect/core.js';

const quiet = { warn() {}, info() {}, error() {} };
const DAY = 86400e3;
const T = new Date(2026, 5, 1, 21, 0, 0).getTime();

const systemOf = (call) => (call?.messages || []).filter((m) => m.role === 'system')
  .map((m) => m.content.map((c) => c.text).join('')).join('\n');

/** 造一个「所有会撒谎的字段都在 madeAt 那一刻生成的」数据目录。 */
function seed(dataDir, madeAt) {
  const st = initState(madeAt);
  st.self.drift = { applied: { sensitivity: -0.3 }, at: madeAt };
  writeFileSync(join(dataDir, 'affect.json'), JSON.stringify(st));
  writeFileSync(join(dataDir, 'insights.json'), JSON.stringify({
    at: madeAt,
    lines: [{ kind: 'work', text: '你天天来，我天天在', at: madeAt }],
  }));
  writeFileSync(join(dataDir, 'life.json'), JSON.stringify({ doing: '在翻旧聊天记录', until: madeAt + 60 * 60e3 }));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ownerQQ: '42' }));
}

function hostAt(clock, dataDir) {
  const calls = [];
  const ctx = {
    llm: {
      listProviders: () => ['p'],
      listModels: async () => [{ id: 'm' }],
      async *stream(opts) {
        calls.push(opts);
        yield { type: 'text-delta', index: 0, text: '嗯' };
        yield { type: 'finish', reason: { kind: 'done' } };
      },
    },
    effect: (fn) => fn(),
    webServer: { register: () => () => {} },
  };
  const host = createHost(ctx, { dataDir, now: () => clock, log: quiet, autoStart: false, sleep: async () => {}, mergeWindowMs: 0 });
  const say = () => host.handleEvent({
    post_type: 'message', message_type: 'private', user_id: 42, raw_message: '在吗', time: Math.floor(clock / 1000),
  });
  return { calls, say };
}

test('时间旅行：一年后，所有「最近/此刻」的说法都不许留下', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-aging-'));
  seed(dataDir, T - 365 * DAY);
  const { calls, say } = hostAt(T, dataDir);
  await say();
  const sys = systemOf(calls[0]);

  assert.doesNotMatch(sys, /没那么在意|更敏感了/, '一年前的人格叙事不许再说「我最近」');
  assert.doesNotMatch(sys, /你天天来，我天天在/, '一年前的周自述不许再说「你最近的想法」');
  assert.doesNotMatch(sys, /在翻旧聊天记录/, '一小时后就该结束的「此刻」不许还挂着');
});

test('时间旅行：反方向也要成立——刚发生的事必须真的在上下文里', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqc-aging-fresh-'));
  seed(dataDir, T - 60e3); // 一分钟前生成的
  const { calls, say } = hostAt(T, dataDir);
  await say();
  const sys = systemOf(calls[0]);

  assert.match(sys, /没那么在意|更敏感了/, '刚结算的人格叙事应该说出来');
  assert.match(sys, /你天天来，我天天在/, '刚写的周自述应该说出来');
  assert.match(sys, /在翻旧聊天记录/, '还没到点的「此刻」应该说出来');
});
