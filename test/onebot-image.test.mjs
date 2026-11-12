// 发图：OneBot 没有「发表情」这个 action，表情包就是一张图。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SEND_IMAGE_BYTES, imageSegment, sendImage, sendText } from '../src/onebot.js';

const fakeBot = () => {
  const calls = [];
  return {
    calls,
    async call(action, params) { calls.push({ action, params }); return { message_id: 1 }; },
  };
};

test('本地文件：读成 base64，不把路径丢给网关', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-img-'));
  const file = join(dir, 'a.png');
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const seg = imageSegment(file);
  assert.equal(seg.type, 'image');
  assert.match(seg.data.file, /^base64:\/\//);
  assert.equal(Buffer.from(seg.data.file.slice(9), 'base64').length, 4);
});

test('URL 原样给：让网关自己去取，省一次读盘和编码', () => {
  assert.equal(imageSegment('https://example.com/a.jpg').data.file, 'https://example.com/a.jpg');
  assert.equal(imageSegment('http://example.com/a.gif').data.file, 'http://example.com/a.gif');
});

test('Buffer 也行', () => {
  assert.equal(imageSegment(Buffer.from('x')).data.file, `base64://${Buffer.from('x').toString('base64')}`);
});

test('认不出来就抛，别发一个注定失败的空请求', () => {
  assert.throws(() => imageSegment(''), /没给图/);
  assert.throws(() => imageSegment('D:/根本/不存在.png'), /找不到/);
  assert.throws(() => imageSegment(Buffer.alloc(0)), /空的/);
  const huge = Buffer.alloc(MAX_SEND_IMAGE_BYTES + 1);
  assert.throws(() => imageSegment(huge), /太大/);
});

test('私聊走 user_id，群聊走 group_id，消息体是一个 image 段', async () => {
  const bot = fakeBot();
  await sendImage(bot, { kind: 'private', userId: 42 }, 'https://example.com/a.jpg');
  assert.equal(bot.calls[0].action, 'send_private_msg');
  assert.equal(bot.calls[0].params.user_id, 42);
  assert.deepEqual(bot.calls[0].params.message, [{ type: 'image', data: { file: 'https://example.com/a.jpg' } }]);

  await sendImage(bot, { kind: 'group', groupId: 7, userId: 42 }, 'https://example.com/b.jpg');
  assert.equal(bot.calls[1].action, 'send_group_msg');
  assert.equal(bot.calls[1].params.group_id, 7);
});

test('文字那条没被改坏', async () => {
  const bot = fakeBot();
  await sendText(bot, { kind: 'private', userId: 42 }, '在吗');
  assert.deepEqual(bot.calls[0].params.message, [{ type: 'text', data: { text: '在吗' } }]);
});
