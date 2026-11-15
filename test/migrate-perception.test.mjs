// 迁移脚本的判定：哪些老记录该搬、搬完长什么样。（不测 --write，那是对真实数据的操作。）
import test from 'node:test';
import assert from 'node:assert/strict';
import { planMigration } from '../scripts/migrate-perception.mjs';

const card = (texts) => ({ records: texts.map((t, i) => ({ id: `m_${i}`, text: t, createdAt: 1000 + i })) });

test('整段图注：描述搬进感知记录，正文换成 gist', () => {
  const [p] = planMigration(card(['（你看了一眼他刚发来的图：粉发女孩举着牌子。知道就行，别复述）好看吗']));
  assert.equal(p.desc, '粉发女孩举着牌子。');
  assert.equal(p.newText, '他发了一张图好看吗');
  assert.equal(p.perception.pixels, false, '老图没有原图');
  assert.equal(p.perception.memoryId, 'm_0');
});

test('另一种旧格式也认', () => {
  const [p] = planMigration(card(['[他发了一张图：一个像素女孩在点头]']));
  assert.equal(p.desc, '一个像素女孩在点头');
  assert.equal(p.newText, '他发了一张图');
});

test('普通记录不动', () => {
  assert.deepEqual(planMigration(card(['他喜欢猫', '（你看了一眼他刚发来的图：。知道就行，别复述）'])), []);
});
