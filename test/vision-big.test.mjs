// 大图/大表情：读得进来，但必须先压小才发得出去。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { MAX_IMAGE_BYTES, MAX_LOCAL_BYTES, shrinkImage, sniffMime } from '../src/vision.js';

test('本地文件的读取额度比「发给接口」的上限宽', () => {
  assert.ok(MAX_LOCAL_BYTES > MAX_IMAGE_BYTES, '不然十几兆的原图连读都读不进来');
});

test('静态大图：缩到上限内，并转成 jpeg', async () => {
  // 真随机像素，PNG 压不动，保证源文件真的超过 8MB
  const w = 2000;
  const h = 1500;
  const raw = randomBytes(w * h * 3);
  const big = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  assert.ok(big.length > MAX_IMAGE_BYTES, `样本要真的超过上限：${big.length}`);

  const small = await shrinkImage(big, { max: 1024 });
  assert.ok(small, '应该压得出来');
  assert.equal(sniffMime(small), 'image/jpeg');
  assert.ok(small.length < big.length / 2, `压完应该小一个量级：${big.length} → ${small.length}`);

  const meta = await sharp(small).metadata();
  assert.ok(Math.max(meta.width, meta.height) <= 1024, `实际 ${meta.width}×${meta.height}`);
});

test('压不动的输入返回 null，绝不抛——她要能说「看不到」，不能整轮哑掉', async () => {
  assert.equal(await shrinkImage(Buffer.from('这不是图片')), null);
  assert.equal(await shrinkImage(null), null);
});
