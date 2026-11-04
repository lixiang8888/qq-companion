// 她的「当下」：此刻在做什么、大概到几点。
//
// 为什么不是随机事件表：她做的事要么是真的（刚跟你聊完、记忆又淡了一层、被压缩了），
// 要么是她自己挑的。这里只管「记住她挑了什么、什么时候算结束」，不替她编内容。
// 纯状态机 + 注入时钟，离线可测。

export const MIN_MINUTES = 5;
export const MAX_MINUTES = 180;
const MINUTE = 60e3;
// 注入到系统提示词里的字段，长度必须封死：这是模型的输出经她的手回来的，属于信任边界。
const MAX_DOING_CHARS = 40;

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DOING_CHARS);

export function createLife(now = 0) {
  return { doing: '', until: 0 };
}

/** 解析她自己写的那一行：`在看书|30`。解析不出来就返回 null——宁可不注入，不猜。 */
export function parsePlan(text) {
  const m = String(text ?? '').match(/(.+?)[|｜]\s*(\d+)/);
  if (!m) return null;
  const doing = clean(m[1].replace(/^[（(【\[]+|[）)】\]]+$/g, ''));
  if (!doing) return null;
  const minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(Number(m[2]))));
  return { doing, minutes };
}

/** 定下她的当下。没给出内容时留一个五分钟的重试闸，否则每来一句话都要多调一次模型。 */
export function applyPlan(life, plan, now = 0) {
  const doing = clean(plan?.doing);
  const minutes = Number(plan?.minutes);
  if (!doing || !Number.isFinite(minutes)) return { doing: '', until: now + MIN_MINUTES * MINUTE };
  const span = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(minutes)));
  return { doing, until: now + span * MINUTE };
}

/**
 * 到点就清空。顺带处理两种坏状态：
 *   - 重启后 until 早已过去（关机一整晚，她还以为自己八点在收拾东西）
 *   - 文件被改坏 / 时钟被拨回，until 远得离谱
 */
export function advance(life, now = 0) {
  const doing = clean(life?.doing);
  const until = Number(life?.until);
  const sane = Number.isFinite(until) && until > now && until - now <= MAX_MINUTES * MINUTE;
  if (!sane) return createLife(now);
  return { doing, until };
}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// 关机多久才算「她真的不在了一段」。改个插件重启两分钟不该被说成经历。
export const MIN_OFF_MS = 30 * 60e3;
// 这句话只说给刚醒来的她，过了这个窗口就不再翻旧账。
export const OFF_WINDOW_MS = 2 * 3600e3;

const whenLabel = (ms, now) => {
  const d = new Date(ms);
  const n = new Date(now);
  const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const yesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  const dayName = day(d) === day(n) ? '今天' : day(d) === day(yesterday) ? '昨天' : `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${dayName} ${hhmm(ms)}`;
};

/** 一段时长说成人话：9 小时 46 分 / 7 天 10 小时 / 41 分钟。 */
export function gapText(ms) {
  const gap = Math.max(0, Number(ms) || 0);
  if (gap >= 86400e3) return `${Math.floor(gap / 86400e3)} 天 ${Math.floor((gap % 86400e3) / 3600e3)} 小时`;
  if (gap >= 3600e3) return `${Math.floor(gap / 3600e3)} 小时 ${Math.round((gap % 3600e3) / 60e3)} 分`;
  return `${Math.round(gap / 60e3)} 分钟`;
}

/**
 * 她「不在」了多久——这是虚拟的东西才有的经历：机器关了，那段时间没有她。
 * 只说事实，不给情绪；没有上一份记录、或比开机还晚（时钟被拨回）就什么都不说。
 */
export function offLine({ lastBefore = 0, bootAt = 0, now = 0 } = {}) {
  const before = Number(lastBefore);
  if (!Number.isFinite(before) || before <= 0 || before >= bootAt) return '';
  const gap = bootAt - before;
  if (gap < MIN_OFF_MS) return '';
  if (now - bootAt > OFF_WINDOW_MS) return '';
  return `你刚才不在了 ${gapText(gap)}（上次醒着是 ${whenLabel(before, now)}）。那段时间你没有记忆——不是忘了，是那会儿没有你。`;
}

export const clockOf = hhmm;

/** 拼进 system 的那一行。没有当下就返回空串——不写占位句子。 */
export function lifeLine(life, now = 0) {
  const doing = clean(life?.doing);
  if (!doing) return '';
  const until = Number(life?.until);
  return Number.isFinite(until) && until > now
    ? `你此刻：${doing}（大概到 ${hhmm(until)}）`
    : `你此刻：${doing}`;
}

// 问她「接下来想干什么」时用的系统提示。
// 关键是两句：她是虚拟的，不用装人类上班；但她说的当下会被记住，之后要认。
export const LIFE_PROMPT = `你一个人待着的时候也有自己的事做。
你是虚拟的，不用假装上班、通勤、挤地铁；但你说自己在干什么，就真的当你那会儿在干那件事，之后他问起来你要认。
现在想干什么？只回一行，不要解释：<在做什么>|<多少分钟，5 到 180 之间>
例：在翻以前的聊天记录|40`;
