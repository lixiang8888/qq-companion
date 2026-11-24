// 把 DSH 的 ctx.llm 流式接口包成「一次调用拿一整段文本」。
//
// 形状来自 dsh-llm 的公开契约（0.2.1-rc.3 取证）：
//   ctx.llm.stream({ provider, model, messages, maxTokens?, temperature?, reasoningEffort? }) 产出 chunk，
//   { type:'text-delta', text } 是正文，{ type:'finish', reason:{kind:'done'|'error'|'aborted', failure?} } 收尾。
// 我们不消费 reasoning-delta（那是思考，不是要说的话）。
//
// 消息形状取证（同上，dsh-llm/README.md + lib/index.js）：
//   user 可以是 request-only，只带 role/content；
//   assistant 必须是 durable —— 核心层 forAdapter 读 message.source.replayState，
//   deepseek 适配层读 message.source.kind，缺 source 就是 TypeError。
//   所以这里给 assistant 补 id + source。
//
// 2026-11-24：推理模型的思考也算在 maxTokens 里。DSH 默认路由是 deepseek-flash +
// reasoningEffort=max，工具调用（压缩摘要这种）给 800 预算会被思考吃光，正文是空的
// ——真机上「压缩返回空内容」就是这个。这里加一条兜底：**带输出上限的调用**拿到空正文时，
// 换 reasoningEffort:'off'、预算翻倍再要一次。主对话不带 maxTokens，行为不变。

import { randomUUID } from 'node:crypto';

const DEFAULT_RETRY_CAP = 8000;

export function createLlmComplete(ctx, { provider, model, maxTokens, temperature, reasoningEffort } = {}, { log = null } = {}) {
  if (!ctx?.llm?.stream) throw new Error('ctx.llm.stream 不可用：DSH 版本不匹配');

  const assistantSource = { kind: 'model', ...(provider ? { provider } : {}), ...(model ? { model } : {}) };

  return async function complete({ system, messages, maxTokens: cap, temperature: temp, reasoningEffort: effort, onUsage }) {
    const list = [];
    if (system) {
      list.push({ id: randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: String(system) }] });
    }
    for (const m of messages || []) {
      const text = String(m.text ?? '');
      const imgs = Array.isArray(m.images) ? m.images.filter(Boolean) : [];
      if (m.role === 'assistant') {
        list.push({ id: randomUUID(), role: 'assistant', source: { ...assistantSource }, content: [{ type: 'text', text }] });
        continue;
      }
      // 带图的那一轮：图片块必须排在文字前面（官方要求，反过来会报错）。
      if (imgs.length) {
        list.push({ role: 'user', content: [...imgs.map((url) => ({ type: 'image_url', image_url: { url } })), { type: 'text', text }] });
      } else {
        list.push({ role: 'user', content: [{ type: 'text', text }] });
      }
    }

    const tp = temp ?? temperature;
    const limit = cap ?? maxTokens;

    async function run({ tokenCap, effortId }) {
      const opts = { provider, model, messages: list };
      if (tokenCap) opts.maxTokens = tokenCap;
      if (tp !== undefined) opts.temperature = tp;
      if (effortId !== undefined) opts.reasoningEffort = effortId;
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
    }

    const out = await run({ tokenCap: limit, effortId: effort ?? reasoningEffort });
    // 空正文 + 设了输出上限 = 大概率是思考把预算吃光了（压缩摘要最常踩）。
    // 换「不思考」、预算翻倍再要一次；还是空就认了，交给调用方处理。
    if (String(out || '').trim() === '' && limit) {
      const bigger = Math.min(DEFAULT_RETRY_CAP, limit * 2);
      log?.info?.(`模型输出是空的（思考可能吃掉了 ${limit} token），换不思考、预算 ${bigger} 再要一次`);
      try {
        const again = await run({ tokenCap: bigger, effortId: 'off' });
        if (String(again || '').trim()) return again;
        log?.warn?.(`换不思考再要一次还是空的（${bigger} token）`);
      } catch (e) {
        // 有的模型不认 reasoningEffort：重试失败就退回原结果，别把整次调用弄挂。
        log?.warn?.(`换不思考重试失败：${e.message}`);
      }
    }
    return out;
  };
}
