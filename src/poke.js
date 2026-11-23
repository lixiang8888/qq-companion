// 他戳了戳她（QQ 的「拍一拍」）。这是一次真实的"叫你一下"，不是一条消息。
//
// 根因（2026-11-23）：handleEvent 只认 post_type === 'message'，戳一戳是 notice，
// 事件确实到了网关和插件，只是在第一行就被丢掉——所以她完全没反应，不是她不理人。
//
// 反应规矩：被戳一下，多少给点反应（一句话 / 戳回去 / 两个都要）；
// 只有真的不想理才 [沉默]——那也得是"她选的不理"，不是代码漏了。

import { sanitizeSecrets } from './memory/sanitize.js';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * 从 OneBot 事件里认出「他戳了戳她」。
 * SnowLuma 实测形状：{ post_type:'notice', notice_type:'notify', sub_type:'poke',
 *   user_id:<对方QQ>, sender_id:<谁戳的>, target_id:<被戳的>, action, suffix }
 * @returns {null | {kind:'private', senderId:string, targetId:string, peerId:string, action:string, suffix:string, at:number}}
 */
export function normalizePoke(ev) {
  if (!ev || ev.post_type !== 'notice') return null;
  if (ev.notice_type !== 'notify' || ev.sub_type !== 'poke') return null;
  if (ev.group_id) return null;                       // 只认私聊：这个插件只服务一个人
  const peerId = String(ev.user_id ?? '');
  const senderId = String(ev.sender_id ?? peerId);
  if (!peerId || !senderId) return null;
  return {
    kind: 'private',
    peerId,
    senderId,
    targetId: String(ev.target_id ?? ''),
    action: clip(ev.action, 20),
    suffix: clip(ev.suffix, 30),
    at: (Number(ev.time) || Math.floor(Date.now() / 1000)) * 1000,
  };
}

/** 他对她做的那一下，用一句话说清楚（自定义拍一拍会带 action/suffix）。 */
export function pokeText(poke = {}) {
  const action = String(poke.action || '').trim() || '戳了戳';
  const suffix = String(poke.suffix || '').trim();
  return `他${action}你${suffix ? `（${suffix}）` : ''}`;
}

/**
 * 有的客户端不把拍一拍发成 notice，而是塞进一条消息里：带 poke/shake 段，
 * 或者只剩 QQ 自己的兜底文本「[戳一戳]请使用最新版手机QQ体验新功能。」。
 * 2026-11-23 真机日志（SnowLuma）就是这种：
 *   `私聊 [璃湘]: ID:… [窗口抖动] [戳一戳]请使用最新版手机QQ体验新功能。`
 * @param {{userId?:string, text?:string, segments?:object[], at?:number}} msg 归一化后的消息
 * @returns {null | {kind:'private',peerId:string,senderId:string,targetId:string,action:string,suffix:string,at:number}}
 */
export function pokeFromMessage(msg) {
  if (!msg) return null;
  const segs = Array.isArray(msg.segments) ? msg.segments : [];
  const hit = segs.find((s) => s && (s.type === 'poke' || s.type === 'shake'));
  const text = String(msg.text || '').trim();
  // 兜底文本只认 QQ 自己那几句，别把"我拍一拍你"这种正常聊天当成拍一拍。
  const fallback = /请使用最新版手机QQ体验新功能/.test(text)
    || /^\[?戳一戳\]?(请使用最新版手机QQ体验新功能)?[。.]?$/.test(text);
  if (!hit && !fallback) return null;
  return {
    kind: 'private',
    peerId: String(msg.userId || ''),
    senderId: String(msg.userId || ''),   // 私聊里能动她的就是对面那个人
    targetId: '',
    action: hit?.type === 'shake' ? '抖了抖' : '戳了戳',
    suffix: '',
    at: Number(msg.at) || 0,
  };
}

/**
 * 被戳之后那一次「回什么」的提示。不是用户消息，她看完别当成他说了什么。
 * 只给真事：现在几点、她此刻在干什么、你们最后一句是什么、她什么状态。
 */
export function composePokeReply({ clock = '', poke = {}, doing = '', lastLine = '', feel = '' } = {}) {
  const lines = [`【他戳了你一下】现在 ${clock}。`];
  lines.push(`${sanitizeSecrets(pokeText(poke))}——是 QQ 的拍一拍，不是一条消息。`);
  if (doing) lines.push(`你此刻：${sanitizeSecrets(doing).slice(0, 60)}。`);
  if (lastLine) lines.push(`你们最后说的一句是：「${sanitizeSecrets(lastLine).slice(0, 100)}」。`);
  if (feel) lines.push(`你现在的状态：${sanitizeSecrets(feel).slice(0, 40)}。话会跟着这个状态变，但别说出来。`);
  lines.push('回一句很短的（不超过 12 个字）。被戳了一下，多少给点反应；真的不想理，就只写 [沉默]。');
  lines.push('想反过来戳他，就把 [戳回去] 写在最后——可以只戳回去、不说话。');
  lines.push('只回你要说的那一句，别写旁白，别解释。');
  return lines.join('\n');
}

/**
 * 解读她对被戳的反应。
 * @returns {{text:string, pokeBack:boolean, silent:boolean}}
 */
export function parsePokeReaction(text) {
  const raw = String(text ?? '').trim();
  const silent = /\[沉默\]/.test(raw);
  const pokeBack = /\[戳回去\]/.test(raw);
  const clean = raw
    .replace(/\[(?:戳回去|沉默)\]/g, '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return {
    text: clean,
    pokeBack,
    silent,
    // 既没说话也没戳回去、又不是明确沉默：至少回戳一下——被戳了没反应才是怪事。
    ...(clean || pokeBack || silent ? {} : { pokeBack: true }),
  };
}
