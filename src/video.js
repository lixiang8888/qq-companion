// 看视频：抽几帧、按「画面变了多少」挑、拼成一张图给模型看。
//
// 思路来自 dsh-see-now（Apache-2.0，见 THIRD_PARTY_NOTICES.md）：**先判断这一帧值不值得看，
// 再决定传不传**；留下来的几帧**拼进同一张图**——一张图里塞 4 帧还是 8 帧，价格几乎一样。
//
// 我们不搬它的抓屏那套（那要整套 ffmpeg 采集管线），只借这两条：
//   1. 变化分：相邻帧在 64×36 网格上的平均像素差，0–255；
//   2. 拼图：挑出来的帧摆进同一张 798×462，一次调用看完。
//
// 听不到声音。这一点必须写进提示词——不然她会替视频编台词。

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// sharp 只在真要看图时才 import——没装或者坏掉时，插件的入口仍要能加载。
let sharpImpl = null;
async function getSharp() {
  if (sharpImpl) return sharpImpl;
  sharpImpl = (await import('sharp')).default;
  return sharpImpl;
}

export const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
export const MAX_SECONDS = 90;      // 只往前 90 秒看：再长也看不出更多
export const SAMPLE_EVERY = 2;      // 每 2 秒一帧
export const MAX_SAMPLES = 45;      // 90 秒 / 2 秒
export const KEEP_FRAMES = 6;       // 拼图里最多几帧
export const SHEET_WIDTH = 798;     // 对齐 DeepSeek 的 42px patch 网格（800 会白算一列）
export const SHEET_HEIGHT = 462;

const GRID_W = 64;
const GRID_H = 36;

export const VIDEO_PROMPT = `这是他发来的一段视频，按时间顺序从里面抽出的几帧（左上到右下，不一定是等间隔）。
说清楚：画面里是什么、有谁、在做什么动作、有没有明显的场景切换。
**你听不到声音**——不要编台词、不要猜背景音乐、不要描述"他说了什么"。
看不清就直说看不清。`;

/** ffmpeg 在哪：先看配置，再看插件自己的 bin 目录，最后交给 PATH。 */
export function findFfmpeg({ binDir = '', explicit = '' } = {}) {
  if (explicit && existsSync(explicit)) return explicit;
  if (binDir) {
    for (const name of ['ffmpeg.exe', 'ffmpeg']) {
      const p = join(binDir, name);
      if (existsSync(p)) return p;
    }
  }
  return 'ffmpeg';
}

const run = (bin, args, { timeoutMs = 120000 } = {}) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    if (err) { reject(Object.assign(err, { stderr: String(stderr || '') })); return; }
    resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
  });
});

/** 时长（秒）。读不到就说不知道——0 表示不知道，不是 0 秒。 */
export function parseDuration(stderr = '') {
  const m = String(stderr).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Math.round(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
}

/**
 * 抽帧。返回 [{ at: 秒, jpeg }]，按时间顺序。
 * 一次 ffmpeg 调用抽完整个窗口，比逐帧调用快一个数量级。
 */
export async function extractFrames({ file, buffer, ffmpeg = 'ffmpeg', seconds = MAX_SECONDS, every = SAMPLE_EVERY, timeoutMs = 120000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-video-'));
  let inputDir = '';
  try {
    let input = file;
    // 手里只有字节（QQ 那边常常只有 url）就先落一个临时文件：ffmpeg 要能 seek，管道不行。
    if (!input && buffer) {
      inputDir = mkdtempSync(join(tmpdir(), 'qqc-vin-'));
      input = join(inputDir, 'in.mp4');
      writeFileSync(input, buffer);
    }
    if (!input) throw new Error('没有视频文件');
    const pattern = join(dir, 'f%03d.jpg');
    await run(ffmpeg, [
      '-v', 'error',
      '-i', String(input),
      '-t', String(seconds),
      '-vf', `fps=1/${every},scale=480:-2`,
      '-q:v', '5',
      pattern,
    ], { timeoutMs });
    const files = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
    return files.map((f, i) => ({ at: i * every, jpeg: readFileSync(join(dir, f)) }));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清不掉也不影响结果 */ }
    if (inputDir) { try { rmSync(inputDir, { recursive: true, force: true }); } catch { /* 同上 */ } }
  }
}

/**
 * 相邻两帧「画面变了多少」：64×36 网格上逐通道的平均差，0–255。
 *
 * 不用灰度：红→绿灰度只差 17，屏幕上却是换了一整屏。第一版用灰度，真机一测
 * 「红/绿/蓝三个场景」的两处硬切只拿到 17 和 34 分，等于什么都没看出来。
 */
export async function changeScore(a, b) {
  const sharp = await getSharp();
  const [ra, rb] = await Promise.all([
    sharp(a).resize(GRID_W, GRID_H, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
    sharp(b).resize(GRID_W, GRID_H, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
  ]);
  let sum = 0;
  for (let i = 0; i < ra.length; i += 1) sum += Math.abs(ra[i] - rb[i]);
  return Math.round(sum / ra.length);
}

/**
 * 挑帧：第一帧、最后一帧、以及画面变化最大的几帧。
 * 首尾必留是因为「开头是什么、结尾是什么」最容易说明这段视频在讲什么。
 */
export function pickByChange(frames = [], scores = [], k = KEEP_FRAMES) {
  const n = frames.length;
  if (!n) return [];
  if (n <= k) return frames.map((f, i) => ({ ...f, score: scores[i] ?? 0 }));
  const picked = new Set([0, n - 1]);
  const ranked = scores.map((s, i) => ({ s, i })).sort((x, y) => y.s - x.s);
  for (const { i } of ranked) {
    if (picked.size >= k) break;
    if (i > 0 && i < n - 1) picked.add(i);
  }
  return [...picked].sort((a, b) => a - b).map((i) => ({ ...frames[i], score: scores[i] ?? 0 }));
}

/** 把几帧拼进同一张图：一格里一张，从左到右、从上到下。 */
export async function packSheet(frames = [], { width = SHEET_WIDTH, height = SHEET_HEIGHT } = {}) {
  const n = frames.length;
  if (!n) throw new Error('没有帧可以拼');
  const sharp = await getSharp();
  const cols = n <= 4 ? 2 : n <= 6 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const cw = Math.floor(width / cols);
  const ch = Math.floor(height / rows);
  const tiles = [];
  for (let i = 0; i < n; i += 1) {
    const img = await sharp(frames[i].jpeg)
      .resize(cw, ch, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: 82 })
      .toBuffer();
    tiles.push({ input: img, left: (i % cols) * cw, top: Math.floor(i / cols) * ch });
  }
  return sharp({ create: { width, height, channels: 3, background: { r: 12, g: 12, b: 12 } } })
    .composite(tiles)
    .jpeg({ quality: 82 })
    .toBuffer();
}

/** 抽帧 → 打分 → 挑 → 拼。返回一张图和它覆盖的时间范围。 */
export async function videoSheet({ file, buffer, ffmpeg = 'ffmpeg', seconds = MAX_SECONDS, keep = KEEP_FRAMES, timeoutMs = 120000 } = {}) {
  const frames = await extractFrames({ file, buffer, ffmpeg, seconds, timeoutMs });
  if (!frames.length) throw new Error('一帧都抽不出来');
  const scores = [];
  for (let i = 0; i < frames.length; i += 1) {
    scores.push(i === 0 ? 0 : await changeScore(frames[i - 1].jpeg, frames[i].jpeg));
  }
  const picked = pickByChange(frames, scores, keep);
  const sheet = await packSheet(picked);
  return {
    sheet,
    frames: picked.length,
    sampled: frames.length,
    from: picked[0]?.at ?? 0,
    to: picked[picked.length - 1]?.at ?? 0,
  };
}

/** 正文怎么写。看不到就说看不到，别让她替视频编内容。 */
export function withVideoText(text, look, { label = '视频' } = {}) {
  const body = String(text || '').trim();
  if (!look?.ok) {
    const why = look?.reason ? `（${look.reason}）` : '';
    return `${body}${body ? ' ' : ''}（他发来一段${label}，你看不了${why}——就说你看不到，别猜里面是什么）`;
  }
  return `${body}${body ? ' ' : ''}（他发来一段${label}，你看了几眼：${look.text}。听不到声音，别编台词）`;
}
