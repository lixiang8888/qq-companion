// 装好之后第一件事：自检。不改任何东西，只报告「哪一步没通」。
//
// 单独成模块而不是写在脚本里，是为了能离线测：用一个假 dataDir 跑断言，
// 不必真的连 SnowLuma。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const check = (name, ok, detail = '') => ({ name, ok, detail });

export function preflight({ dataDir } = {}) {
  const out = [];
  const cfgFile = join(dataDir, 'config.json');
  out.push(check('配置存在', existsSync(cfgFile), cfgFile));
  let cfg = {};
  if (existsSync(cfgFile)) {
    try { cfg = JSON.parse(readFileSync(cfgFile, 'utf8')); } catch (e) { out.push(check('配置可解析', false, e.message)); }
  }

  out.push(check('ownerQQ 已设置', Boolean(cfg.ownerQQ), cfg.ownerQQ ? `…${String(cfg.ownerQQ).slice(-4)}` : '没设置就不会回任何人的私聊'));
  out.push(check('OneBot WS 地址', Boolean(cfg.onebot?.wsUrl), cfg.onebot?.wsUrl || ''));
  out.push(check('OneBot HTTP 地址', Boolean(cfg.onebot?.httpUrl), cfg.onebot?.httpUrl || ''));
  out.push(check('OneBot token', Boolean(cfg.onebot?.token), cfg.onebot?.token ? '已设置' : 'SnowLuma 开启鉴权时必须填'));

  const personaDir = join(dataDir, 'personas');
  const personas = existsSync(personaDir) ? readdirSync(personaDir).filter((n) => n.endsWith('.md')) : [];
  // 人格卡没写不是错：启动时 ensurePersona 会写一份默认的。❌ 只留给真需要人动手的项。
  out.push(check('人格卡', true, personas.join(', ') || '还没有（启动时自动写入一份）'));

  for (const [name, file] of [['情绪状态', 'affect.json'], ['记忆卡', 'memory.json']]) {
    const f = join(dataDir, file);
    if (!existsSync(f)) { out.push(check(name, true, '还没有数据（正常）')); continue; }
    try {
      const data = JSON.parse(readFileSync(f, 'utf8'));
      const detail = file === 'memory.json'
        ? `${(data.records || []).length} 条记忆`
        : `心情 ${(data.mood?.v ?? 0).toFixed(2)} · 信任 ${(data.relation?.trust ?? 0).toFixed(2)}`;
      out.push(check(name, true, detail));
    } catch (e) {
      out.push(check(name, false, `读坏了：${e.message}`));
    }
  }

  return { ok: out.every((c) => c.ok), checks: out };
}

/** 真连一次 OneBot（只读调用，不发消息）。 */
export async function pingOneBot({ httpUrl, token }, fetchImpl = globalThis.fetch) {
  if (!httpUrl) return check('OneBot 连通', false, '没有 httpUrl');
  try {
    const res = await fetchImpl(`${httpUrl.replace(/\/$/, '')}/get_login_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return check('OneBot 连通', false, `HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    const uin = body?.data?.user_id;
    return check('OneBot 连通', Boolean(uin), uin ? `登录号 ${uin}` : '返回里没有 user_id');
  } catch (e) {
    return check('OneBot 连通', false, e.message);
  }
}
