// 只读面板：情绪/关系/人格/记忆/她的房间一眼看完。
//
// 刻意不写前端插槽：这是自检页，服务端渲染就够（不自动刷新——表单里要粘 token，
// 一刷新输入就没了），不用浏览器也能用测试断言它「显示了什么」。
// 所有动态文本都转义——记忆和日记里可以有任意字符，包括标签。

import { CLARITY_LABEL, isLive, stats as memoryStats } from './memory/card.js';
import { TRAITS, TRAIT_BASE } from './affect/core.js';
import { moodLabel, stateLine } from './affect/inject.js';
import { clockOf, gapText } from './life.js';
import { balanceLine, spendLine } from './budget.js';
import { renderInsights } from './insights.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const bar = (value, max = 1, cls = '') => {
  const pct = Math.max(0, Math.min(100, Math.round((Number(value) / max) * 100)));
  return `<div class="bar ${cls}"><i style="width:${pct}%"></i></div>`;
};

const TRAIT_LABEL = {
  sensitivity: '敏感', aggression: '好斗', resilience: '恢复', openness: '开放', attachment: '依恋',
};

function section(title, body) {
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

/**
 * @param {{state: object, memory: object, gateway: string, session: object, persona: string, config: object, now: number}} o
 */
export function renderPanel({ state, memory, recalls = [], gateway = 'unknown', session = {}, history = [], checks = [], persona = '', config = {}, life = null, diaries = [], budget = null, alive = null, insights = null, qzone = null, proactive = null, now = Date.now() } = {}) {
  const cfg = config || {};
  const conn = cfg.onebot || {};
  const traits = TRAITS.map((k) => {
    const v = state.self[k];
    const dev = v - TRAIT_BASE[k];
    const tag = Math.abs(dev) < 0.05 ? '' : dev > 0 ? ' ↑' : ' ↓';
    return `<div class="row"><span>${TRAIT_LABEL[k]}</span>${bar(v)}<b>${v.toFixed(2)}${tag}</b></div>`;
  }).join('');

  const patterns = Object.entries(state.self.patterns || {});
  const patternText = patterns.length
    ? `<ul>${patterns.map(([k, p]) => `<li>${escapeHtml(k)}：${p.hits} 次 / ${Math.round((p.lastAt - p.firstAt) / 86400e3)} 天</li>`).join('')}</ul>`
    : '<p class="dim">还没有累积中的模式</p>';

  const mem = memory ? memoryStats(memory) : { total: 0, forgotten: 0, archived: 0 };
  // forgottenAt 可能是 0（测试里时钟从 0 开始），所以只能用 !== undefined 判断。
  const live = (memory?.records || []).filter((r) => r.forgottenAt === undefined);
  const recent = live.slice(-10).reverse();
  const memoryList = recent.length
    ? `<ul>${recent.map((r) => `<li><span class="tag">${CLARITY_LABEL[r.clarity] || r.clarity}</span> ${escapeHtml(r.text)} <a href="?pin=${encodeURIComponent(r.id)}">${r.pinned ? '取消置顶' : '置顶'}</a> <a href="?forget=${encodeURIComponent(r.id)}">忘记</a></li>`).join('')}</ul>`
    : '<p class="dim">记忆卡还是空的</p>';

  // 遗忘是可逆的：软删除的还在，90 天内点一下就回来。
  const gone = (memory?.records || []).filter((r) => r.forgottenAt !== undefined).slice(-5).reverse();
  const goneText = gone.length
    ? `<p class="dim">已遗忘 ${mem.archived} 条（保留 90 天，可找回）：</p><ul>${gone.map((r) => `<li>${escapeHtml(r.text)} <a href="?restore=${encodeURIComponent(r.id)}">找回</a></li>`).join('')}</ul>`
    : '';

  // 失效也是可逆的：旧说法被新说法取代，但可能判错，所以要给撤销入口。
  const stale = (memory?.records || []).filter((r) => r.supersededAt !== undefined).slice(-5).reverse();
  const staleText = stale.length
    ? `<p class="dim">已失效 ${mem.superseded || 0} 条（旧说法被新说法取代，可撤销）：</p><ul>${stale.map((r) => `<li>${escapeHtml(r.text)} <a href="?unsupersede=${encodeURIComponent(r.id)}">撤销</a></li>`).join('')}</ul>`
    : '';

  const snaps = (state.self.snapshots || []).map((s) => `<li><a href="?rollback=${encodeURIComponent(s.at)}">回滚到 ${escapeHtml(new Date(s.at).toLocaleDateString())}</a></li>`).join('');

  // 她的房间：此刻在干什么、最近三天她给自己写的日记。
  const doing = life?.doing
    ? `<p class="big">${escapeHtml(life.doing)}${life.until > now ? ` <span class="dim">（大概到 ${escapeHtml(clockOf(life.until))}）</span>` : ''}</p>`
    : '<p class="dim">这会儿没在做什么（到点她会自己定）</p>';
  // 关机时长是她唯一「亲身」经历过的虚空：机器关了，那段时间没有她。
  // 每周一次的自述：日有日记、月有人格漂移，中间这一层就是它。
  const insightText = insights?.at
    ? `<p class="dim">${escapeHtml(new Date(insights.at).toLocaleDateString())} 写的：</p><p>${escapeHtml(renderInsights(insights))}</p>`
    : '<p class="dim">还没写过自述</p>';
  const awakeText = alive?.before
    ? `<p class="dim">上次醒着：${escapeHtml(new Date(alive.before).toLocaleString())}（这次开机前空了 ${escapeHtml(gapText(alive.offMs))}）</p>`
    : '<p class="dim">还没有上一次的记录</p>';
  const diaryText = (diaries || []).length
    ? diaries.map((d) => `<p><span class="tag">${escapeHtml(d.date)}</span></p><p class="diary">${escapeHtml(d.text)}</p>`).join('')
    : '<p class="dim">还没写过日记</p>';

  // 钱包：她自己的 token 和账户余额分开写——两个数来源不同，混在一起就是骗人。
  const bal = budget?.balance;
  const moneyText = budget
    ? [
      spendLine(budget) || '今天还没说过话',
      bal?.ok ? `${balanceLine(bal)}（${escapeHtml(clockOf(bal.at))} 查的）` : `余额查不到（${escapeHtml(bal?.reason || '还没查过')}）`,
    ].join('<br>')
    : '<p class="dim">还没有账</p>';

  // 最近的对话：她说不像人话时，先看这一段，比翻 session.json 快。
  const chat = (history || []).slice(-8);
  const chatText = chat.length
    ? `<ul>${chat.map((m) => {
      const who = m.role === 'user' ? '他' : '她';
      const when = m.at ? escapeHtml(new Date(m.at).toLocaleTimeString()) : '';
      const text = String(m.text || '');
      return `<li><span class="tag">${who}${when ? ` · ${when}` : ''}</span>${escapeHtml(text.length > 120 ? `${text.slice(0, 120)}…` : text)}</li>`;
    }).join('')}</ul>`
    : '<p class="dim">还没有对话</p>';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QQ 陪伴体 · 自检</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui, "Segoe UI", sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 0 0 8px; opacity: .7; font-weight: 600; }
  section { border: 1px solid rgba(127,127,127,.3); border-radius: 10px; padding: 12px 14px; margin: 12px 0; }
  .row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
  .row span { width: 44px; opacity: .75; }
  .bar { flex: 1; height: 6px; background: rgba(127,127,127,.25); border-radius: 3px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: #4d6bfe; }
  .row b { width: 64px; text-align: right; font-weight: 500; }
  ul { margin: 6px 0 0; padding-left: 18px; }
  li { margin: 2px 0; }
  .dim { opacity: .55; margin: 4px 0 0; }
  .tag { font-size: 11px; padding: 1px 5px; border-radius: 4px; background: rgba(127,127,127,.18); margin-right: 4px; }
  .big { font-size: 15px; }
  .diary { white-space: pre-wrap; }
  form label { display: block; margin: 6px 0; }
  form input { width: 100%; box-sizing: border-box; padding: 5px 7px; margin-top: 2px;
    border: 1px solid rgba(127,127,127,.4); border-radius: 6px; background: transparent; color: inherit; font: inherit; }
  form button { margin-top: 10px; padding: 6px 16px; border-radius: 6px; border: 0; background: #4d6bfe; color: #fff; font: inherit; }
</style></head>
<body>
<h1>QQ 陪伴体</h1>
<p class="dim">自检页 · ${escapeHtml(new Date(now).toLocaleString())} · <a href="?">刷新</a></p>

${section('体检', checks.length
    ? `<ul>${checks.map((c) => `<li>${c.ok ? '✅' : '❌'} ${escapeHtml(c.label)} — ${escapeHtml(c.detail)}</li>`).join('')}</ul>`
    : '<p class="dim">没有可检查的项</p>')}
${section('此刻', `<p class="big">${escapeHtml(stateLine(state))}</p><p class="dim">心情「${escapeHtml(moodLabel(state.mood.v))}」· 情绪强度 ${state.emotion.intensity.toFixed(2)}</p>`)}
${section('她的房间', `${doing}${awakeText}${insightText}${diaryText}`)}
${section('空间', (() => {
  const last = qzone?.lastDecision;
  const why = last
    ? `<p class="dim">上次判定：${escapeHtml(last.reason)}（${escapeHtml(new Date(last.at).toLocaleTimeString())}）</p>`
    : '';
  if (!qzone?.lastText) {
    return `<p class="dim">还没发过说说</p>${why}<p class="dim"><a href="?qztest=1">测一下：现在让她写一条</a></p>`;
  }
  const when = qzone.lastPostAt ? new Date(qzone.lastPostAt).toLocaleString() : '';
  return `<p class="dim">${escapeHtml(when)} 发的（${escapeHtml(qzone.lastKind || '')}）</p><p>${escapeHtml(qzone.lastText)}</p>`
    + `${why}<p class="dim">tid=${escapeHtml(qzone.lastTid || '')} · <a href="?qzcheck=1">立刻查评论</a> · <a href="?qzdelete=1">删掉这条</a></p>`;
})())}
${section('她会不会来找你', (() => {
  const p = proactive || {};
  const e = p.expect || {};
  const gate = p.gate;
  const when = e.at ? new Date(e.at).toLocaleString() : '还没算（等她说完一轮）';
  const why = e.why ? `<span class="dim">（${escapeHtml(e.why)}）</span>` : '';
  const verdict = gate?.ok
    ? '<p class="big">现在可以找他</p>'
    : `<p class="dim">现在不发：${escapeHtml(gate?.reason || '未开启')}</p>`;
  const thought = p.lastThought?.text
    ? `<p class="dim">上次想的是（${escapeHtml(new Date(p.lastThought.at).toLocaleString())}）：「${escapeHtml(p.lastThought.text.slice(0, 80))}」</p>`
    : '';
  return `<p>期待时间：${escapeHtml(when)}${why}</p>${verdict}`
    + `<p class="dim">今天主动 ${p.count || 0} 次 · 连发没回 ${p.consecutive || 0} 条 · 想过 ${p.thinks?.n || 0} 次</p>${thought}`;
})())}
${section('人格', `${traits}<p class="dim">${escapeHtml(state.self.narrative || '还没有发生过漂移')}</p><p class="dim">待结算的模式：</p>${patternText}<p class="dim">快照 ${(state.self.snapshots || []).length} 版</p>${snaps ? `<ul>${snaps}</ul>` : ''}`)}
${section('记忆', `<p>共 ${mem.total} 条（清晰 ${mem.vivid || 0} / 清楚 ${mem.clear || 0} / 模糊 ${mem.fuzzy || 0} / 只剩印象 ${mem.trace || 0}），已遗忘 ${mem.forgotten || 0}</p>${memoryList}${staleText}${goneText}`)}
${section('最近想起', recalls.length    ? `<ul>${recalls.map((r) => `<li><span class="tag">${escapeHtml(new Date(r.at).toLocaleTimeString())}</span>「${escapeHtml(r.query)}」→ ${r.picks.length ? r.picks.map((t) => escapeHtml(t)).join('、') : '<span class="dim">没想起什么</span>'}</li>`).join('')}</ul>`
    : '<p class="dim">还没有聊过</p>')}
${section('最近对话', chatText)}
${section('运行', `<p>网关：${escapeHtml(gateway)} · 会话 ${session.size ?? 0} 条 · 已压缩 ${session.compactions ?? 0} 次 · 人格 ${escapeHtml(persona || '未设置')}</p>${session.lastError ? `<p class="dim">上次压缩失败：${escapeHtml(session.lastError.message)}</p>` : ''}`)}
${section('钱包', moneyText)}
${section('设置', `<form method="post" action="config">
  <label>ownerQQ（只回这个人的私聊；不填她谁都不回）<input name="ownerQQ" value="${escapeHtml(cfg.ownerQQ || '')}"></label>
  <label>OneBot WS 地址<input name="wsUrl" value="${escapeHtml(conn.wsUrl || '')}" placeholder="ws://127.0.0.1:3001"></label>
  <label>OneBot HTTP 地址<input name="httpUrl" value="${escapeHtml(conn.httpUrl || '')}" placeholder="http://127.0.0.1:3000"></label>
  <label>OneBot token（HTTP 用；留空表示不改）<input name="token" type="password" placeholder="${conn.token ? '已设置，留空不改' : '没开鉴权就留空'}"></label>
  <label>WS 单独的 token（SnowLuma 的 HTTP/WS 常不一样；一样就留空）<input name="wsToken" type="password" placeholder="${conn.wsToken ? '已设置，留空不改' : '和 HTTP 相同就留空'}"></label>
  <label>人格名<input name="persona" value="${escapeHtml(cfg.persona || '')}" placeholder="小鲸鱼"></label>
  <button type="submit">保存</button>
</form>`)}
</body></html>`;
}


