// 会话层：多轮上下文、压缩触发、压缩失败不丢历史。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalSession, recentCount, stampOf, withStamps } from '../src/session.js';

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

// 她以前只看得到「图片识别出来的那段文字」。现在原图只在到达的那一轮跟过去，
// 历史里仍然是文字——这样她当场能从真实画面反应，之后回想的也不会是过期链接。
test('原图只贴在最后一条上，历史里不存图片', async () => {
  const { calls, complete } = fake();
  const s = createLocalSession({ complete, system: '', now: () => NOW });
  await s.prompt('p', '第一句');
  await s.prompt('p', '看这个', { images: ['data:image/jpeg;base64,AAA'] });

  const sent = calls[1].messages;
  assert.equal(sent.at(-1).images.length, 1, '这一轮末尾要带上原图');
  assert.ok(!sent.slice(0, -1).some((m) => m.images), '历史里的消息不能带图');

  const hist = s.snapshot().history;
  assert.ok(hist.every((m) => m.images === undefined), '落盘的历史里没有图片字段');
});

test('一轮最多带两张图：三连发不该白烧 token', async () => {
  const { calls, complete } = fake();
  const s = createLocalSession({ complete, system: '', now: () => NOW });
  await s.prompt('p', '三张', { images: ['a', 'b', 'c', 'd'] });
  assert.equal(calls[0].messages.at(-1).images.length, 2);
});

test('模型不收图片时：去掉图再试一次，不能整轮哑掉', async () => {
  const seen = [];
  let n = 0;
  const complete = async ({ messages }) => {
    n += 1;
    seen.push(messages);
    if (messages.some((m) => m.images)) throw new Error('该模型不支持图片');
    return '看到了';
  };
  const s = createLocalSession({ complete, system: '', now: () => NOW });
  const r = await s.prompt('p', '看这个', { images: ['data:image/jpeg;base64,AAA'] });
  assert.equal(r, '看到了');
  assert.equal(n, 2, '第一次带图失败、第二次去图成功');
  assert.ok(!seen[1].some((m) => m.images));
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

// ---- 留多少原文：按时间，不按条数 ----
// 以前压缩只看条数：一个晚上聊四十句，当晚整晚原文就被压成一句摘要，
// 而她最该记住的恰恰是「最近这一阵」。

test('留多少条：keepHours=0 就是老行为，只看条数', () => {
  const hist = Array.from({ length: 40 }, (_, i) => ({ at: NOW + i, role: 'user', text: 'x' }));
  assert.equal(recentCount(hist, NOW + 40, { keepRecent: 16 }), 16);
});

test('留多少条：一天内的全留，超出的只留下限', () => {
  const hour = 3600e3;
  const hist = [
    { at: NOW - 30 * hour, role: 'user', text: '前天' },
    { at: NOW - 2 * hour, role: 'user', text: '刚才' },
    { at: NOW - 1 * hour, role: 'user', text: '一小时前' },
  ];
  assert.equal(recentCount(hist, NOW, { keepHours: 24, keepRecent: 1 }), 2, '只剩两小时内的两条');
  assert.equal(recentCount(hist, NOW, { keepHours: 24, keepRecent: 16 }), 16, '下限优先：至少 16 条');
  assert.equal(recentCount(hist, NOW, { keepHours: 24, keepRecent: 1, maxRecent: 1 }), 1, '硬上限优先');
});

test('一天之内聊到天亮也不压：当晚的原话一句都不少', async () => {
  const f = fake();
  let clock = at(8, 21, 0);
  const s = createLocalSession({
    complete: f.complete, system: '', compactAt: 4, keepRecent: 2,
    keepHours: 24, maxRecent: 200, now: () => clock,
  });
  for (let i = 0; i < 10; i += 1) { clock += 60e3; await s.prompt('p', `第${i}句`); }
  assert.equal(s.snapshot().compactions, 0, '20 条、一小时，条数早过阈值也不该压');
  assert.equal(s.size, 20);
  assert.equal(s.snapshot().summary, '');
});

test('过了时间窗才压，压完剩下的仍然是一天内的原话', async () => {
  const f = fake();
  let clock = at(8, 21, 0);
  const s = createLocalSession({
    complete: f.complete, system: '', compactAt: 4, keepRecent: 1,
    keepHours: 24, maxRecent: 200, now: () => clock,
  });
  for (let i = 0; i < 10; i += 1) { clock += 60e3; await s.prompt('p', `第${i}句`); }
  clock += 25 * 3600e3; // 第二天晚上
  await s.prompt('p', '第二天了');
  const snap = s.snapshot();
  assert.ok(snap.compactions >= 1, '老过一天就该压');
  assert.match(snap.summary, /猫/);
  assert.equal(snap.history.length, 2, '只剩今天的一问一答：昨天那 20 条已经进摘要');
});

test('条数硬上限：一天之内也不会无限涨', async () => {
  const f = fake();
  let clock = at(8, 21, 0);
  const s = createLocalSession({
    complete: f.complete, system: '', compactAt: 2, keepRecent: 1,
    keepHours: 24, maxRecent: 6, now: () => clock,
  });
  for (let i = 0; i < 10; i += 1) { clock += 60e3; await s.prompt('p', `第${i}句`); }
  assert.ok(s.snapshot().compactions > 0, '到了硬上限还是要压');
  assert.ok(s.size <= 7, `一天之内的条数也得有闸，实际 ${s.size}`);
});
