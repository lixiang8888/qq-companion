// 真机验证：插件装上之后，问一次 DSH 里的自己「你活着吗」。
//
// 只是只读 GET：/qq-companion/api/state。它同时证明三件事——插件加载了、
// 路由注册了、插件能读到自己那份状态。

export const DEFAULT_BASE = 'http://127.0.0.1:12045';

/**
 * @param {{baseUrl?: string, fetchImpl?: Function, timeoutMs?: number}} [o]
 */
export async function checkPanel({ baseUrl = DEFAULT_BASE, fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  const url = `${String(baseUrl).replace(/\/$/, '')}/qq-companion/api/state`;
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, url, detail: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    if (!body?.ok) return { ok: false, url, detail: '返回不是预期的 JSON' };
    return {
      ok: true,
      url,
      gateway: body.gateway,
      line: body.line,
      memory: body.memoryStats?.total ?? 0,
      session: body.session?.size ?? 0,
      persona: body.persona,
    };
  } catch (e) {
    return { ok: false, url, detail: e.message };
  }
}

/** 把检查结果翻译成一句人话 + 下一步。 */
export function verdict(r) {
  if (!r.ok) return `没连上插件接口（${r.detail}）：可能没装、没重启，或 DSH 端口不是这个。`;
  if (r.gateway === 'connected') return '插件在跑，QQ 网关已连上。';
  if (r.gateway === 'reconnecting') return '插件在跑，但 QQ 网关连不上：查 SnowLuma 是否登录、token 与端口。';
  if (r.gateway === 'error') return '插件在跑，但网关配置有问题：检查 config.json 的 onebot.wsUrl。';
  return `插件在跑，网关状态 ${r.gateway || '未知'}：确认 enabled=true 且填了 wsUrl。`;
}
