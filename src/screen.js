// 她知不知道他这会儿在电脑上干什么。
//
// 只读前台窗口的「应用名 + 窗口标题」——不截屏、不上传、不留历史。
// 为什么不上截图：那是把整张桌面交给接口，而「在 VS Code 里改 host.js」这句话
// 已经够她知道他在忙什么了。截图留给「看看这个」那种他主动发的东西。
//
// 边界：
//   · 密码管理器一类整条不给（连应用名都不说）
//   · 微信/QQ 这类只说在哪个应用，不说窗口标题——标题就是联系人名字
//   · 只留最新一条，覆盖写，不攒时间线
//   · 五分钟没读到新的就不说，而不是拿两小时前的窗口冒充「此刻」

import { execFile } from 'node:child_process';

export const SCREEN_TTL = 5 * 60e3;
export const MAX_TITLE = 60;
export const MAX_APP = 24;

/** 整条不给的应用（进程名小写包含匹配）。 */
export const BLOCKED_APPS = ['1password', 'keepass', 'bitwarden', 'lastpass', 'authy', 'authenticator', 'enpass', 'dashlane'];
/** 只说在哪个应用、不说标题的应用：标题里常常就是「在跟谁说话」。 */
export const QUIET_APPS = ['wechat', 'weixin', 'qq', 'tim', 'telegram', 'discord', 'feishu', 'lark', 'dingtalk', 'wecom'];
/**
 * 标题命中这些词就只留应用名。
 * 按应用分类只能挡住「明显的」，挡不住一篇叫「离婚协议」的文档——内容敏感的东西
 * 长什么样没法穷举，所以给他一个可以自己加的词表。默认只放最不需要解释的几个。
 */
export const MUTE_WORDS = ['密码', '银行', '转账', '支付', '身份证', '体检', '医院', '病历', '离职', '简历', '工资', '借款', '贷款', '保险', '合同'];

/**
 * 读一次前台窗口。失败一律返回 null——看不见就说看不见，不猜。
 * 用一次性进程而不是常驻守护进程：一小时读十几次，不值得为一个轮询器常驻一个 PowerShell。
 */
export const READ_SCRIPT = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
$h = [FgWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][FgWin]::GetWindowTextW($h, $sb, 512)
$procId = 0
[void][FgWin]::GetWindowThreadProcessId($h, [ref]$procId)
$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
$p.ProcessName
$sb.ToString()`;

const clean = (text, max) => String(text ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** PowerShell 的两行输出 → {app, title}。第一行进程名，第二行窗口标题。 */
export function parseScreen(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  const app = clean(lines[0], MAX_APP);
  const title = clean(lines.slice(1).join(' '), MAX_TITLE);
  if (!app) return null;
  return { app, title };
}

/** 隐私过滤 + 截断。返回 null 表示这条整个不给。 */
export function sanitize(info, { blocked = BLOCKED_APPS, quiet = QUIET_APPS, mute = MUTE_WORDS } = {}) {
  const app = clean(info?.app, MAX_APP);
  if (!app) return null;
  const low = app.toLowerCase();
  if (blocked.some((b) => low.includes(String(b).toLowerCase()))) return null;
  const raw = clean(info?.title, MAX_TITLE);
  const noisy = quiet.some((q) => low.includes(String(q).toLowerCase()));
  const sensitive = mute.some((w) => raw.includes(String(w)));
  return { app, title: noisy || sensitive ? '' : raw };
}

/** 隔着多久说的。五分钟外的不说——那不是「此刻」。 */
export function screenLine(state, now = 0, { ttl = SCREEN_TTL } = {}) {
  const at = Number(state?.at) || 0;
  const app = clean(state?.app, MAX_APP);
  if (!at || !app) return '';
  const gap = Number(now) - at;
  if (!(gap >= 0) || gap >= ttl) return '';
  const mins = Math.floor(gap / 60e3);
  const ago = mins < 1 ? '刚刚' : `${mins} 分钟前`;
  const title = clean(state?.title, MAX_TITLE);
  return `他此刻：在 ${app}${title ? `「${title}」` : ''}（${ago}看到的）`;
}

/** 真正去读。读不到返回 null，绝不编一个出来。 */
export function readScreen({ timeoutMs = 8000, exec = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', READ_SCRIPT],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => {
          if (err) { resolve(null); return; }
          resolve(parseScreen(stdout));
        });
    } catch {
      resolve(null);
    }
  });
}
