// 看图：来源识别、data URL、描述接回正文。不连网的部分全在这里钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_IMAGE_BYTES, dataUrlOf, describeImage, framesPerImage, imageSegmentsOf, imageSourceOf, mimeOf, withImageText } from '../src/vision.js';

test('从消息段里挑图片', () => {
  const segs = [{ type: 'text' }, { type: 'image' }, { type: 'image' }];
  assert.equal(imageSegmentsOf(segs).length, 2);
  assert.equal(imageSegmentsOf(null).length, 0);
});

test('图片来源认三种：网址、file://、磁盘路径', () => {
  assert.deepEqual(imageSourceOf({ data: { url: 'https://a/q.jpg' } }), { kind: 'url', value: 'https://a/q.jpg' });
  assert.deepEqual(imageSourceOf({ data: { url: 'file://D:/x/q.jpg' } }), { kind: 'file', value: 'D:/x/q.jpg' });
  assert.deepEqual(imageSourceOf({ data: { file: 'D:\\x\\q.png' } }), { kind: 'file', value: 'D:\\x\\q.png' });
  assert.equal(imageSourceOf({ data: { file: 'q.jpg' } }), null, '只有文件名、没有目录时不猜');
});

test('MIME 按扩展名，未知当 jpeg', () => {
  assert.equal(mimeOf('a.png'), 'image/png');
  assert.equal(mimeOf('D:/x/a.WEBP'), 'image/webp');
  assert.equal(mimeOf('a.unknown'), 'image/jpeg');
});

test('data URL 里带上了 MIME 和 base64', () => {
  const url = dataUrlOf(Buffer.from([1, 2, 3]), 'image/png');
  assert.ok(url.startsWith('data:image/png;base64,'));
  assert.equal(Buffer.from(url.split(',')[1], 'base64').length, 3);
});

test('看图失败一律不抛：没图、没 key、HTTP 错、空描述都返回 ok:false', async () => {
  assert.equal((await describeImage({ dataUrl: '' })).ok, false);
  assert.equal((await describeImage({ dataUrl: 'data:x', key: '' })).ok, false);
  const http500 = async () => ({ ok: false, status: 500 });
  assert.equal((await describeImage({ dataUrl: 'data:x', key: 'k', fetchImpl: http500 })).ok, false);
  const empty = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '  ' } }] }) });
  assert.equal((await describeImage({ dataUrl: 'data:x', key: 'k', fetchImpl: empty })).ok, false);
  const boom = async () => { throw new Error('断网'); };
  const r = await describeImage({ dataUrl: 'data:x', key: 'k', fetchImpl: boom });
  assert.equal(r.ok, false);
  assert.match(r.reason, /断网/);
});

test('看图成功：把描述取出来，顺手带 usage', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: ' 一个粉发小人，头顶三个问号 ' } }], usage: { total_tokens: 88 } }) });
  const r = await describeImage({ dataUrl: 'data:x', key: 'k', fetchImpl: ok });
  assert.equal(r.ok, true);
  assert.equal(r.text, '一个粉发小人，头顶三个问号');
  assert.equal(r.usage.total_tokens, 88);
});

test('描述接回正文：接在前面，原文不动', () => {
  const out = withImageText('你看这个', [{ ok: true, text: '一只猫' }]);
  assert.match(out, /你看了一眼他刚发来的图：一只猫/);
  assert.match(out, /别复述/);
  assert.match(out, /你看这个$/, '他原话放在最后，别改动');
});

test('看不到图时明确告诉她别猜', () => {
  const out = withImageText('你看这个', [{ ok: false, reason: 'HTTP 500' }]);
  assert.match(out, /你看这个/);
  assert.match(out, /你看不到内容/);
  assert.match(out, /别猜/);
});

test('上限是个具体的数，不是「很大」', () => {
  assert.ok(MAX_IMAGE_BYTES > 0 && MAX_IMAGE_BYTES <= 32 * 1024 * 1024);
});

test('表情包也算图：mface/face 有 url 就送去看看', async () => {
  const { imageSegmentsOf } = await import('../src/vision.js');
  const segs = [
    { type: 'mface', data: { url: 'https://x/a.gif' } },
    { type: 'face', data: { emoji_id: '1' } },
    { type: 'face', data: {} },
  ];
  assert.equal(imageSegmentsOf(segs).length, 2, '有 url 或 emoji_id 的才算');
});

test('按字节认格式：扩展名会说谎', async () => {
  const { sniffMime } = await import('../src/vision.js');
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  assert.equal(sniffMime(Buffer.from('GIF89a', 'ascii')), 'image/gif');
  assert.equal(sniffMime(Buffer.concat([Buffer.from('RIFF0000', 'ascii'), Buffer.from('WEBP', 'ascii')])), 'image/webp');
  assert.equal(sniffMime(Buffer.from([1, 2, 3])), '');
});

test('看不到图时，把腾讯给的表情名说出来（不是她猜的）', async () => {
  const { withImageText } = await import('../src/vision.js');
  const out = withImageText('', [{ ok: false, reason: 'HTTP 403' }], ['[哈哈]']);
  assert.match(out, /\[哈哈\]/);
  assert.match(out, /看不到/);
});


test('动图抽帧：均匀采样，首尾都取到', async () => {
  const { pickFrameIndexes } = await import('../src/vision.js');
  assert.deepEqual(pickFrameIndexes(0, 4), []);
  assert.deepEqual(pickFrameIndexes(1, 4), [0]);
  assert.deepEqual(pickFrameIndexes(3, 4), [0, 1, 2], '不够多就全取');
  assert.deepEqual(pickFrameIndexes(10, 4), [0, 3, 6, 9]);
});

test('动图抽帧：sharp 不在或坏了就返回 null，退化成只看第一帧', async () => {
  const { extractGifFrames } = await import('../src/vision.js');
  const broken = () => { throw new Error('没有 sharp'); };
  assert.equal(await extractGifFrames(Buffer.from('x'), { sharpImpl: broken }), null);
});

test('动图抽帧：单帧图不当动图处理', async () => {
  const { extractGifFrames } = await import('../src/vision.js');
  const fake = () => ({ metadata: async () => ({ pages: 1 }) });
  assert.equal(await extractGifFrames(Buffer.from('x'), { sharpImpl: fake }), null);
});

test('动图抽帧：默认八帧——四帧会漏掉动作中间态', async () => {
  const { extractGifFrames, pickFrameIndexes } = await import('../src/vision.js');
  const out = Buffer.from([0xff, 0xd8, 0xff]);
  const chain = { resize: () => chain, jpeg: () => chain, toBuffer: async () => out };
  const fake = () => ({ metadata: async () => ({ pages: 20 }), ...chain });
  const r = await extractGifFrames(Buffer.from('x'), { sharpImpl: fake });
  assert.equal(r.pages, 20);
  assert.equal(r.frames.length, 8, '20 帧的动图取 8 帧，不是 4 帧');
  assert.deepEqual(pickFrameIndexes(20, 8), [0, 3, 5, 8, 11, 14, 16, 19], '均匀采样，首尾都取到');
  // 十来兆的大动图降到四帧：多抽只是多花内存，认得出是什么就够了。
  const big = await extractGifFrames(Buffer.from('x'), { sharpImpl: fake, max: 4 });
  assert.equal(big.frames.length, 4);
});

test('动图抽帧：多帧时每帧缩成 jpeg，且取单帧必须带 pages:1', async () => {
  const { extractGifFrames } = await import('../src/vision.js');
  const seen = [];
  const out = Buffer.from([0xff, 0xd8, 0xff]);
  const chain = { resize: () => chain, jpeg: () => chain, toBuffer: async () => out };
  // 只给 { page } 时 sharp 返回「从这页往下全部」的叠加图：一个 300×11700 的表情包
  // 会变成 300×8700、1.6MB 的大图，接口直接 400。这条测试钉住 pages:1。
  const fake = (buf, opts) => { seen.push(opts); return { metadata: async () => ({ pages: 4 }), ...chain }; };
  const r = await extractGifFrames(Buffer.from('x'), { sharpImpl: fake });
  assert.equal(r.pages, 4);
  assert.equal(r.frames.length, 4);
  assert.ok(r.frames[0].startsWith('data:image/jpeg;base64,'), '必须是 jpeg，png 太大');
  assert.ok(seen.some((o) => o?.page !== undefined && o?.pages === 1), '取单帧必须带 pages:1');
  assert.ok(seen.every((o) => o?.pages === undefined || o?.pages === 1), '只有 metadata 那次可以不限页数');
});

test('看图预算被思考吃掉：finish_reason=length 就加预算重试，真空的不重试', async () => {
  // 真事（2026-11-22，4 帧动图）：max_tokens=800 全被 reasoning 吃掉、content 空、finish_reason=length，
  // 她只拿到「看不到」。给第二次更大的预算就能拿到描述。
  const calls = [];
  const lengthThenOk = async (url, opts) => {
    calls.push(JSON.parse(opts.body).max_tokens);
    if (calls.length === 1) {
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '' } }] }) };
    }
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '一个粉发女孩在喝饮料' } }], usage: { total_tokens: 99 } }) };
  };
  const r = await describeImage({ dataUrl: 'data:x', key: 'k', fetchImpl: lengthThenOk });
  assert.equal(r.ok, true);
  assert.match(r.text, /粉发女孩/);
  assert.deepEqual(calls, [3000, 6000], '重试要给更大的预算');

  // 动图（帧多、思考更重）可以单独给更大的一档：4000 → 8000。
  const animCalls = [];
  const animLengthThenOk = async (url, opts) => {
    animCalls.push(JSON.parse(opts.body).max_tokens);
    if (animCalls.length === 1) return { ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '' } }] }) };
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '八帧里她在跺脚' } }] }) };
  };
  const a = await describeImage({ dataUrls: ['data:1', 'data:2'], key: 'k', fetchImpl: animLengthThenOk, maxTokens: 4000 });
  assert.match(a.text, /跺脚/);
  assert.deepEqual(animCalls, [4000, 8000], '动图给到 4000，不够再翻倍');

  // 真空回复（finish_reason=stop）：不重试，直接报没描述
  const emptyCalls = [];
  const empty = async (url, opts) => {
    emptyCalls.push(1);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '  ' } }] }) };
  };
  const e = await describeImage({ dataUrl: 'data:x', key: 'k', fetchImpl: empty });
  assert.equal(e.ok, false);
  assert.equal(emptyCalls.length, 1);
});

test('图贴过去了但没认出来：不许说「你看不到」，因为画布就在她手里', () => {
  // 真事（2026-11-22）：描述失败（token 被思考吃光），但像素其实已经贴给她了，
  // 正文却写「你看不到内容」→ 她照着回「看不到」。手里有画面就不许说瞎话。
  const out = withImageText('你看这个', [{ ok: false, reason: '模型没给描述' }], ['[动画表情]'], { shown: 1 });
  assert.match(out, /画面你看到了/);
  assert.match(out, /没认出来/);
  assert.doesNotMatch(out, /你看不到内容/);
  assert.match(out, /^你看这个（/, '他原话在最前面，图注接在后面');
  // 真的一张都没贴（没 key / 下载失败）：照旧说看不到
  const blind = withImageText('你看这个', [], [], { shown: 0 });
  assert.match(blind, /你看不到内容/);
});

test('每张图占几个画面名额：单张动图给两帧，多张图各占一个', () => {
  assert.equal(framesPerImage(1, 12), 2, '只有一张动图：给两帧看动作');
  assert.equal(framesPerImage(2, 12), 1, '他连发两张：动图只占一个名额，别挤掉后面那张');
  assert.equal(framesPerImage(1, 1), 1, '静态图就是一帧');
  assert.equal(framesPerImage(1, 12, 4), 4, '名额上限由调用方传进来');
});
