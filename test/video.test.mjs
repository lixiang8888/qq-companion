// 看视频：抽帧打分、挑帧、拼图。抽帧本身要 ffmpeg，那一段单独 gated。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import {
  KEEP_FRAMES, SHEET_HEIGHT, SHEET_WIDTH, VIDEO_PROMPT,
  changeScore, findFfmpeg, packSheet, parseDuration, pickByChange, withVideoText, videoSheet,
} from '../src/video.js';

const solid = (gray, size = 64) => sharp({ create: { width: size, height: size, channels: 3, background: { r: gray, g: gray, b: gray } } }).jpeg().toBuffer();

test('时长：解析 ffmpeg 的 Duration，读不到就返回 0（表示不知道，不是 0 秒）', () => {
  assert.equal(parseDuration('  Duration: 00:00:31.72, start: 0.000000, bitrate: 1000 kb/s'), 32);
  assert.equal(parseDuration('  Duration: 00:02:05.00, start: 0.0'), 125);
  assert.equal(parseDuration('something else'), 0);
});

test('变化分：同一帧是 0，黑白切换接近 255', async () => {
  const black = await solid(0);
  const white = await solid(255);
  assert.equal(await changeScore(black, black), 0);
  const s = await changeScore(black, white);
  assert.ok(s > 240 && s <= 255, `黑白差应该接近 255，实际 ${s}`);
});

test('变化分不按灰度算：红→绿灰度只差 17，屏幕上却是换了一整屏', async () => {
  const rgb = (r, g, b) => sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
  const [red, green, blue] = await Promise.all([rgb(255, 0, 0), rgb(0, 255, 0), rgb(0, 0, 255)]);
  assert.ok(await changeScore(red, green) > 100, '红→绿必须是大变化');
  assert.ok(await changeScore(green, blue) > 100, '绿→蓝必须是大变化');
});

test('挑帧：首尾必留，其余按变化分挑最大的', () => {
  const frames = [0, 1, 2, 3, 4, 5].map((i) => ({ at: i * 2, jpeg: Buffer.from([i]) }));
  const scores = [0, 90, 10, 200, 20, 0];
  const picked = pickByChange(frames, scores, 3);
  assert.deepEqual(picked.map((f) => f.at), [0, 6, 10], '第一帧、变化最大的第 3 帧、最后一帧');
  assert.deepEqual(picked.map((f) => f.score), [0, 200, 0]);
});

test('挑帧：帧数不够就全留，不多造', () => {
  const frames = [{ at: 0, jpeg: Buffer.from([1]) }, { at: 2, jpeg: Buffer.from([2]) }];
  assert.equal(pickByChange(frames, [0, 10], KEEP_FRAMES).length, 2);
  assert.deepEqual(pickByChange([], [], 6), []);
});

test('拼图：一张 798×462 的图，4 帧也能 6 帧也能', async () => {
  const frames = await Promise.all([0, 80, 160, 240, 255, 120].map((g) => solid(g).then((jpeg) => ({ at: 0, jpeg }))));
  for (const n of [1, 4, 6]) {
    const buf = await packSheet(frames.slice(0, n));
    const meta = await sharp(buf).metadata();
    assert.equal(meta.width, SHEET_WIDTH);
    assert.equal(meta.height, SHEET_HEIGHT);
    assert.equal(meta.format, 'jpeg');
  }
});

test('拼图：没有帧要报错，不能返回一张黑图', async () => {
  await assert.rejects(packSheet([]), /没有帧/);
});

test('提示词说清两件事：顺序、以及听不到声音', () => {
  assert.match(VIDEO_PROMPT, /听不到声音/);
  assert.match(VIDEO_PROMPT, /不要编/);
  assert.match(VIDEO_PROMPT, /左上到右下/);
});

test('正文：看成了就说不听到声音，没看成就不许猜', () => {
  const ok = withVideoText('你看这个', { ok: true, text: '一只猫在键盘上走' });
  assert.match(ok, /你看了几眼：一只猫在键盘上走/);
  assert.match(ok, /听不到声音/);
  const bad = withVideoText('你看这个', { ok: false, reason: '没有 ffmpeg' });
  assert.match(bad, /你看不了/);
  assert.match(bad, /别猜/);
  assert.ok(!/你看了几眼/.test(bad));
});

test('ffmpeg 查找：显式路径优先，其次 bin 目录，最后交给 PATH', () => {
  assert.equal(findFfmpeg({ explicit: 'D:/nope/ffmpeg.exe' }), 'ffmpeg', '文件不存在就不认');
  assert.equal(findFfmpeg({}), 'ffmpeg');
});

test('抽帧：机器上没有 ffmpeg 时，videoSheet 要明确失败而不是静默', async (t) => {
  const bin = findFfmpeg({});
  const has = (() => {
    try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
  })();
  if (has) { t.skip('这台机器有 ffmpeg，跳过「没有 ffmpeg」这条'); return; }
  await assert.rejects(videoSheet({ file: 'nope.mp4', ffmpeg: 'definitely-not-ffmpeg' }), /ENOENT|not found|spawn/i);
});
