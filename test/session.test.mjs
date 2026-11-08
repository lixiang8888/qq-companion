// 会话层：多轮上下文、压缩触发、压缩失败不丢历史。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalSession, stampOf, withStamps } from '../src/session.js';

function fake({ reply = '嗯', summary = '早先聊过猫' } = {}) {
  const calls = [];
  const complete = async ({ system, messages, maxTokens }) => {
    calls.push({ system, messages, maxTokens });
    if (/压成一段摘要/.test(system || '')) return summary;
    return reply;
  };
  return { calls, complete };
}

test('压缩失败：留下原因，不丢历史（以前这里什么都没记）', async () => {
  const complete = async ({ system }) => {
    if (/摘要/.test(system || '')) throw new Error('boom: 400');
    return '嗯';
  };
  const s = createLocalSession({ complete, system: 'x', compactAt: 4, keepRecent: 2 });
  for (let i = 0; i < 3; i++) await s.prompt('p', `第 ${i} 句`);
  const snap = s.snapshot();
  assert.match(snap.lastError.message, /boom/);
  assert.ok(snap.history.length > 4, '失败时不能丢历史');
});

test('压缩一直失败：到三倍阈值就丢最老的，并在摘要里说明', async () => {
  const complete = async ({ system }) => {
    if (/摘要/.test(system || '')) throw new Error('boom');
    return '嗯';
  };
  const s = createLocalSession({ complete, system: 'x', compactAt: 4, keepRecent: 2 });
  for (let i = 0; i < 10; i++) await s.prompt('p', `第 ${i} 句`);
  const snap = s.snapshot();
  assert.match(snap.summary, /丢了/, '摘要里要说明丢掉了一部分');
  assert.ok(snap.history.length < 12, `历史不该无限涨，实际 ${snap.history.length}`);
});

test('压缩请求不带 temperature：推理模型会直接拒绝，主对话却正常', async () => {
  const calls = [];
  const complete = async (args) => {
    calls.push(args);
    return /摘要/.test(args.system || '') ? '压好了' : '嗯';
  };
  const s = createLocalSession({ complete, system: 'x', compactAt: 3, keepRecent: 1 });
  for (let i = 0; i < 3; i++) await s.prompt('p', `第 ${i} 句`);
  const squeezed = calls.filter((c) => /摘要/.test(c.system || ''));
  assert.ok(squeezed.length >= 1, '应该发生过压缩');
  for (const c of squeezed) assert.equal('temperature' in c, false);
});

test('system：带记忆使用协议（不是他刚说的、可能过期、不许编）', async () => {
  const f = fake();
  const s = createLocalSession({ complete: f.complete, system: '你是大肥鱼' });
  await s.prompt('p', '你还记得吗');
  const sys = f.calls[0].system;
  assert.match(sys, /不是他这一轮刚说的/);
  assert.match(sys, /以新的为准/);
  assert.match(sys, /不要编造/);
});

test('system 可以是 getter：每轮现取人格，不能把函数源码当人格发过去', async () => {
  const f = fake();
  let persona = '你是蓝色大肥鱼';
  const s = createLocalSession({ complete: f.complete, system: () => persona });
  await s.prompt('p', '你是谁');
  assert.match(f.calls[0].system, /蓝色大肥鱼/);
  assert.doesNotMatch(f.calls[0].system, /=>|personaText/, '函数被 join 成源码是致命静默错误');

  persona = '你是一条小鲸鱼';
  await s.prompt('p', '你现在是谁');
  assert.match(f.calls[1].system, /小鲸鱼/, '每轮重新读人格卡，改了立刻生效');
});

test('空回复：不写进历史，也不假装她说过话', async () => {
  const calls = [];
  const complete = async ({ messages }) => { calls.push(messages.length); return '   '; };
  const s = createLocalSession({ complete, system: 'x' });
  const out = await s.prompt('p', '在吗');
  assert.equal(out, '');
  assert.equal(s.size, 1, '只留用户那句，不留空的 assistant');
  assert.deepEqual(s.snapshot().history.map((m) => m.role), ['user']);
});

test('落盘：重启后接着聊，摘要也在', async () => {
  const f = fake();
  let saved = null;
  const s1 = createLocalSession({ complete: f.complete, system: '', compactAt: 4, keepRecent: 2, persist: (snap) => { saved = snap; } });
  await s1.prompt('p', '一');
  await s1.prompt('p', '二');
  await s1.prompt('p', '三');
  assert.ok(saved?.compactions >= 1, '压缩后应已落盘');

  const s2 = createLocalSession({ complete: f.complete, system: '', initial: saved });
  assert.equal(s2.snapshot().summary, saved.summary);
  assert.equal(s2.size, saved.history.length);
  await s2.prompt('p', '接着说');
  assert.ok(s2.size > saved.history.length, '恢复之后继续累积');
});

test('落盘失败不挡回复', async () => {
  const f = fake();
  const s = createLocalSession({ complete: f.complete, system: '', persist: () => { throw new Error('disk full'); } });
  assert.equal(await s.prompt('p', '在吗'), '嗯');
});

test('摘要不会无限长：超过上限会被再压一次', async () => {
  const long = '这是一段很长的摘要。'.repeat(300); // 3000 字
  const seen = [];
  const complete = async ({ system }) => {
    seen.push(system);
    if (/压成一段摘要/.test(system || '')) return long;
    if (/再压一次/.test(system || '')) return '压短了。'.repeat(10);
    return '嗯';
  };
  const s = createLocalSession({ complete, system: '', compactAt: 4, keepRecent: 2 });
  for (let i = 0; i < 6; i++) await s.prompt('p', `第${i}句`);
  const snap = s.snapshot();
  assert.ok(snap.summary.length <= 1200, `摘要 ${snap.summary.length} 字`);
  assert.ok(seen.some((s2) => /再压一次/.test(s2 || '')), '应触发过一次再压缩');
});

test('再压也压不动时：截尾兜底，不抛错', async () => {
  const long = '啊'.repeat(3000);
  const complete = async ({ system }) => (/再压一次/.test(system || '') ? long : /压成一段摘要/.test(system || '') ? long : '嗯');
  const s = createLocalSession({ complete, system: '', compactAt: 4, keepRecent: 2 });
  for (let i = 0; i < 6; i++) await s.prompt('p', `第${i}句`);
  assert.ok(s.snapshot().summary.length <= 1200);
});

test('并发调用会打乱角色顺序——这正是 host 必须串行的原因', async () => {
  const complete = async () => { await new Promise((r) => setTimeout(r, 5)); return '嗯'; };
  const s = createLocalSession({ complete, system: '' });
  await Promise.all([s.prompt('p', '一'), s.prompt('p', '二')]);
  const roles = s.snapshot().history.map((m) => m.role).join(',');
  assert.equal(roles, 'user,user,assistant,assistant', '如果哪天变成 u,a,u,a，说明会话层自己串行了，这条测试就该改');
});

test('多轮：历史一直在长，回复进历史', async () => {
  const f = fake();
  const s = createLocalSession({ complete: f.complete, system: '你是大肥鱼' });
  assert.equal(await s.prompt('p', '在吗'), '嗯');
  await s.prompt('p', '干嘛呢');
  const snap = s.snapshot();
  assert.equal(snap.history.length, 4);
  assert.equal(snap.history[0].role, 'user');
  assert.equal(snap.history[1].role, 'assistant');
});

test('system：人格 + 固定尾巴 + 本轮上下文', async () => {
  const f = fake();
  const s = createLocalSession({ complete: f.complete, system: '你是大肥鱼' });
  await s.prompt('p', '在吗', { context: '（你心情平常）' });
  const sys = f.calls[0].system;
  assert.match(sys, /大肥鱼/);
  assert.match(sys, /状态只影响语气/);
  assert.match(sys, /心情平常/);
});

test('压缩：超过阈值时把老对话压成摘要，并保留最近原文', async () => {
  const f = fake();
  const s = createLocalSession({ complete: f.complete, compactAt: 6, keepRecent: 4 });
  for (let i = 0; i < 4; i++) await s.prompt('p', `第${i}句`);
  // 4 轮 = 8 条 > 6，应该已经压过
  const snap = s.snapshot();
  assert.ok(snap.compactions >= 1);
  assert.match(snap.summary, /猫/);
  assert.ok(snap.history.length <= 5, `压缩后保留最近原文，实际 ${snap.history.length}`);
  const sys = f.calls.at(-1).system;
  assert.match(sys, /更早的对话摘要/);
});

test('压缩失败：历史不丢、不抛错，下次继续', async () => {
  let failSummarize = true;
  const calls = [];
  const complete = async ({ system }) => {
    calls.push(system);
    if (/压成一段摘要/.test(system || '')) {
      if (failSummarize) throw new Error('boom');
      return '摘要';
    }
    return '好';
  };
  const s = createLocalSession({ complete, compactAt: 4, keepRecent: 2 });
  await s.prompt('p', '一');
  await s.prompt('p', '二');
  await s.prompt('p', '三');
  const snap = s.snapshot();
  assert.equal(snap.compactions, 0);
  assert.ok(snap.history.length === 6, '失败时历史原样保留');
  assert.equal(snap.summary, '');

  failSummarize = false;
  await s.prompt('p', '四');
  assert.ok(s.snapshot().compactions >= 1, '恢复后能压');
});

test('空回复不当成 assistant 空消息', async () => {
  const s = createLocalSession({ complete: async () => '   ', system: '' });
  const r = await s.prompt('p', '在吗');
  assert.equal(r, '');
  assert.equal(s.session || true, true);
});

// 「刚刚」那次事故：前天晚上的抱怨，她第二天说成「刚还嫌我不理你」。
// 原因不是她记错，是拼 messages 时把 at 丢掉了——中间那 47 小时在她眼里不存在。
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m, 0).getTime();
const NOW = at(8, 21, 10);

test('时间戳：只标断层处——第一条、以及隔了半小时以上的那条', () => {
  const out = withStamps([
    { role: 'user', text: '前天那句', at: at(6, 21, 44) },
    { role: 'assistant', text: '前天我回的', at: at(6, 21, 45) },
    { role: 'user', text: '喵喵喵', at: at(8, 21, 4) },
    { role: 'assistant', text: '喵什么', at: at(8, 21, 5) },
  ], NOW);

  assert.match(out[0].text, /^（前天 21:44）前天那句$/);
  assert.equal(out[1].text, '前天我回的', '紧接着的那句不加，省 token');
  assert.match(out[2].text, /^（今天 21:04）喵喵喵$/);
  assert.equal(out[3].text, '喵什么');
});

test('时间戳：昨天 / 前天 / 几天前 / 更早', () => {
  assert.equal(stampOf(at(8, 9, 5), NOW), '今天 09:05');
  assert.equal(stampOf(at(7, 23, 5), NOW), '昨天 23:05');
  assert.equal(stampOf(at(6, 21, 44), NOW), '前天 21:44');
  assert.equal(stampOf(at(4, 8, 0), NOW), '4 天前 08:00');
  assert.equal(stampOf(at(1, 8, 0), NOW), '11-01 08:00');
});

test('加了时间戳之后，模型看到的历史里真的有那 47 小时的断层', async () => {
  const { calls, complete } = fake();
  const s = createLocalSession({
    complete, system: '', now: () => NOW,
    initial: { history: [
      { role: 'user', text: '我不说话，你就不会主动找我是吧', at: at(6, 21, 44) },
      { role: 'assistant', text: '你自己不说话', at: at(6, 21, 45) },
    ] },
  });
  await s.prompt('p', '喵喵喵');
  const sent = calls[0].messages;
  assert.match(sent[0].text, /（前天 21:44）/);
  assert.match(calls[0].system, /关于时间/, 'system 里要告诉她括号是什么');
});

test('压缩的入参也带时间，摘要才不会把旧事洗成永远新鲜', async () => {
  const { calls, complete } = fake({ summary: '他前天嫌我不主动' });
  const s = createLocalSession({
    complete, system: '', now: () => NOW, compactAt: 1, keepRecent: 1,
    initial: { history: [{ role: 'user', text: '我不说话你就不会主动找我是吧', at: at(6, 21, 44) }] },
  });
  await s.prompt('p', '喵喵喵');
  const summaryCall = calls.find((c) => /压成一段摘要/.test(c.system || ''));
  assert.ok(summaryCall, '应该触发压缩');
  assert.match(summaryCall.messages[0].text, /前天 21:44/);
  assert.match(summaryCall.system, /什么时候/);
});
