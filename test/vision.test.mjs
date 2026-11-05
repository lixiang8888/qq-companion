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
  assert.equal(out, '[他发了一张图：一只猫]你看这个');
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
