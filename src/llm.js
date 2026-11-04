// 把 DSH 的 ctx.llm 流式接口包成「一次调用拿一整段文本」。
//
// 形状来自 dsh-llm 的公开契约（0.2.1-rc.3 取证）：
//   ctx.llm.stream({ provider, model, messages, maxTokens?, temperature? }) 产出 chunk，
//   { type:'text-delta', text } 是正文，{ type:'finish', reason:{kind:'done'|'error'|'aborted', failure?} } 收尾。
// 我们不消费 reasoning-delta（那是思考，不是要说的话）。
//
// 消息形状取证（同上，dsh-llm/README.md + lib/index.js）：
//   user 可以是 request-only，只带 role/content；
//   assistant 必须是 durable —— 核心层 forAdapter 读 message.source.replayState，
//   deepseek 适配层读 message.source.kind，缺 source 就是 TypeError。
// 所以这里给 assistant 补 id + source。

import { randomUUID } from 'node:crypto';

export function createLlmComplete(ctx, { provider, model, maxTokens, temperature } = {}) {
  if (!ctx?.llm?.stream) throw new Error('ctx.llm.stream 不可用：DSH 版本不匹配');

  const assistantSource = { kind: 'model', ...(provider ? { provider } : {}), ...(model ? { model } : {}) };

  return async function complete({ system, messages, maxTokens: cap, temperature: temp, onUsage }) {
    const list = [];
    if (system) {
      list.push({ id: randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: String(system) }] });
    }
    for (const m of messages || []) {
      const text = String(m.text ?? '');
      list.push(m.role === 'assistant'
        ? { id: randomUUID(), role: 'assistant', source: { ...assistantSource }, content: [{ type: 'text', text }] }
        : { role: 'user', content: [{ type: 'text', text }] });
    }

    const opts = { provider, model, messages: list };
    const mt = cap ?? maxTokens;
    const tp = temp ?? temperature;
    if (mt) opts.maxTokens = mt;
    if (tp !== undefined) opts.temperature = tp;

    let out = '';
    for await (const chunk of ctx.llm.stream(opts)) {
      if (chunk?.type === 'text-delta') out += chunk.text || '';
      // usage 在协议里紧挨着 finish：这是这次调用花了多少 token 的唯一真实来源。
      else if (chunk?.type === 'usage') onUsage?.(chunk.usage);
      else if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind;
        if (kind === 'error') throw new Error(`模型调用失败：${chunk.reason?.failure?.code || 'UNKNOWN'}`);
        if (kind === 'aborted') throw new Error('模型调用被取消');
      }
    }
    return out;
  };
}
