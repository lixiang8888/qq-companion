// LLM 适配层：流式 → 一整段文本；以及「推理把输出预算吃掉」的兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmComplete } from '../src/llm.js';

function fakeCtx(script) {
  const calls = [];
  return {
    calls,
    llm: {
      async *stream(opts) {
        calls.push(opts);
        const step = script[calls.length - 1];
        if (!step) { yield { type: 'finish', reason: { kind: 'done' } }; return; }
        if (step.usage) yield { type: 'usage', usage: step.usage };
        if (step.text) yield { type: 'text-delta', index: 0, text: step.text };
        yield { type: 'finish', reason: { kind: step.error ? 'error' : 'done', failure: { code: step.error } } };
      },
    },
  };
}

test('主对话（不设输出上限）：只调一次，空就是空', async () => {
  const ctx = fakeCtx([{ text: '' }]);
  const complete = createLlmComplete(ctx, { provider: 'p', model: 'm' });
  assert.equal(await complete({ system: 's', messages: [{ role: 'user', text: 'hi' }] }), '');
  assert.equal(ctx.calls.length, 1, '不带上限就不该自动重试');
});

test('工具调用被思考吃光预算：换 off、预算翻倍再要一次', async () => {
  const logs = [];
  const ctx = fakeCtx([
    { text: '' },                    // 第一次：思考吃掉了 800
    { text: '压缩好的摘要', usage: { inputTokens: 10, outputTokens: 5 } },
  ]);
  const complete = createLlmComplete(ctx, { provider: 'p', model: 'm' }, { log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  const out = await complete({ system: 's', messages: [{ role: 'user', text: '压一下' }], maxTokens: 800 });
  assert.equal(out, '压缩好的摘要');
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[0].maxTokens, 800);
  assert.equal(ctx.calls[1].maxTokens, 1600);
  assert.equal(ctx.calls[1].reasoningEffort, 'off');
  assert.match(logs.join('\n'), /换不思考/);
});

test('显式指定的 reasoningEffort 会传下去', async () => {
  const ctx = fakeCtx([{ text: '好' }]);
  const complete = createLlmComplete(ctx, { provider: 'p', model: 'm' });
  await complete({ system: 's', messages: [{ role: 'user', text: 'hi' }], maxTokens: 400, reasoningEffort: 'low' });
  assert.equal(ctx.calls[0].reasoningEffort, 'low');
});

test('重试也救不回来：返回空，让调用方按老路处理', async () => {
  const ctx = fakeCtx([{ text: '' }, { text: '' }]);
  const complete = createLlmComplete(ctx, { provider: 'p', model: 'm' });
  assert.equal(await complete({ system: 's', messages: [{ role: 'user', text: 'x' }], maxTokens: 200 }), '');
  assert.equal(ctx.calls.length, 2);
});

test('模型报错：照旧抛，不吞', async () => {
  const ctx = fakeCtx([{ error: 'RATE_LIMITED' }]);
  const complete = createLlmComplete(ctx, { provider: 'p', model: 'm' });
  await assert.rejects(() => complete({ system: 's', messages: [] }), /RATE_LIMITED/);
});

test('消息形状：assistant 带 id + source，带图时图在文字前', async () => {
  const ctx = fakeCtx([{ text: '好' }]);
  const complete = createLlmComplete(ctx, { provider: 'p', model: 'm' });
  await complete({
    system: 's',
    messages: [
      { role: 'user', text: '看这张' },
      { role: 'assistant', text: '看到了' },
      { role: 'user', text: '真的吗', images: ['data:image/png;base64,AAA'] },
    ],
  });
  const msgs = ctx.calls[0].messages;
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[2].role, 'assistant');
  assert.ok(msgs[2].id && msgs[2].source?.kind === 'model');
  const last = msgs[3].content;
  assert.equal(last[0].type, 'image_url');
  assert.equal(last[1].type, 'text');
});

test('重试时模型不认 reasoningEffort：退回原空结果，不把整次调用弄挂', async () => {
  const ctx = { calls: [], llm: { async *stream(opts) {
    ctx.calls.push(opts);
    if (ctx.calls.length === 1) { yield { type: 'finish', reason: { kind: 'done' } }; return; }
    throw new Error('UNSUPPORTED_REASONING_EFFORT');
  } } };
  const complete = createLlmComplete(ctx, { provider: 'p', model: 'm' }, { log: { info() {}, warn() {} } });
  assert.equal(await complete({ system: 's', messages: [{ role: 'user', text: 'x' }], maxTokens: 100 }), '');
  assert.equal(ctx.calls.length, 2);
});
