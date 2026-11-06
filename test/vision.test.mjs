// 看图：来源识别、data URL、描述接回正文。不连网的部分全在这里钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_IMAGE_BYTES, dataUrlOf, describeImage, imageSegmentsOf, imageSourceOf, mimeOf, withImageText } from '../src/vision.js';

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

test('动图抽帧：多帧时每帧都变成一张 png', async () => {
  const { extractGifFrames } = await import('../src/vision.js');
  const fake = () => ({
    metadata: async () => ({ pages: 4 }),
    png: () => ({ toBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) }),
  });
  const r = await extractGifFrames(Buffer.from('x'), { sharpImpl: fake });
  assert.equal(r.pages, 4);
  assert.equal(r.frames.length, 4);
  assert.ok(r.frames[0].startsWith('data:image/png;base64,'));
});
