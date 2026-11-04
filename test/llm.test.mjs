// LLM 适配层：按 dsh-llm 的流式契约取文本；错误码要能透传。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmComplete } from '../src/llm.js';

function fakeLlm(chunks) {
  const seen = [];
  return {
    seen,
    llm: {
      async *stream(opts) {
        seen.push(opts);
        for (const c of chunks) yield c;
      },
    },
  };
}

test('把 text-delta 拼成整段；system 放在最前面', async () => {
  const f = fakeLlm([
    { type: 'block-start', index: 0 },
    { type: 'text-delta', index: 0, text: '在' },
    { type: 'text-delta', index: 0, text: '呢' },
    { type: 'finish', reason: { kind: 'done' } },
  ]);
  const complete = createLlmComplete(f, { provider: 'deepseek-official', model: 'deepseek-flash' });
  const out = await complete({ system: '你是大肥鱼', messages: [{ role: 'user', text: '在吗' }] });
  assert.equal(out, '在呢');
  const sent = f.seen[0];
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.messages[0].content[0].text, '你是大肥鱼');
  assert.equal(sent.messages[1].content[0].text, '在吗');
});

test('reasoning-delta 不进正文', async () => {
  const f = fakeLlm([
    { type: 'reasoning-delta', index: 0, text: '想一想' },
    { type: 'text-delta', index: 0, text: '嗯' },
    { type: 'finish', reason: { kind: 'done' } },
  ]);
  const out = await createLlmComplete(f, { provider: 'p', model: 'm' })({ messages: [{ role: 'user', text: 'x' }] });
  assert.equal(out, '嗯');
});

test('finish=error 抛带错误码的异常', async () => {
  const f = fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }]);
  await assert.rejects(
    () => createLlmComplete(f, { provider: 'p', model: 'm' })({ messages: [] }),
    /RATE_LIMIT/,
  );
});

test('maxTokens / temperature 透传，缺省不带', async () => {
  const f = fakeLlm([{ type: 'finish', reason: { kind: 'done' } }]);
  await createLlmComplete(f, { provider: 'p', model: 'm' })({ messages: [], maxTokens: 300, temperature: 0.3 });
  assert.equal(f.seen[0].maxTokens, 300);
  assert.equal(f.seen[0].temperature, 0.3);

  const g = fakeLlm([{ type: 'finish', reason: { kind: 'done' } }]);
  await createLlmComplete(g, { provider: 'p', model: 'm' })({ messages: [] });
  assert.equal('maxTokens' in g.seen[0], false);
});

test('没有 ctx.llm.stream：构造时就报清楚', () => {
  assert.throws(() => createLlmComplete({}), /ctx\.llm\.stream/);
});

// 真实契约：核心层 forAdapter 解引用 message.source.replayState，deepseek 适配层解引用
// message.source.kind。assistant 缺 source 会在真机上变成一次「模型调用失败：UNKNOWN」。
test('assistant 带 id + source，user 保持 request-only', async () => {
  const f = fakeLlm([{ type: 'finish', reason: { kind: 'done' } }]);
  await createLlmComplete(f, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })({
    system: '你是大肥鱼',
    messages: [
      { role: 'user', text: '在吗' },
      { role: 'assistant', text: '在呢' },
      { role: 'user', text: '干嘛呢' },
    ],
  });
  const sent = f.seen[0].messages;
  const asst = sent.filter((m) => m.role === 'assistant');
  assert.equal(asst.length, 1);
  assert.ok(asst[0].id, 'assistant 需要 id');
  assert.equal(asst[0].source.kind, 'model');
  assert.equal(asst[0].source.provider, 'deepseek-official');
  // 复刻两处真实解引用，不许抛
  assert.doesNotThrow(() => { void asst[0].source.replayState; });
  assert.doesNotThrow(() => { void asst[0].source.kind; });

  const users = sent.filter((m) => m.role === 'user');
  assert.equal(users.length, 2);
  for (const u of users) {
    assert.equal(u.id, undefined, 'user 是 request-only，不该带 id');
    assert.equal(u.source, undefined);
  }
  assert.equal(sent[0].source.kind, 'system-prompt');
});
