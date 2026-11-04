// 清单体检：bundle 装不上通常不是逻辑问题，而是清单/补丁/资源对不上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('dsh.bundle.patch 指向真实文件', () => {
  const patch = pkg.dsh?.bundle?.patch;
  assert.ok(patch, '缺少 dsh.bundle.patch');
  assert.ok(existsSync(join(root, patch)), `${patch} 不存在`);
});

test('补丁行：id 与包名一致，且是 insert', () => {
  const text = readFileSync(join(root, pkg.dsh.bundle.patch), 'utf8');
  assert.match(text, /^-\s*insert:/m);
  assert.match(text, new RegExp(`id:\\s*${pkg.name}\\b`));
  assert.match(text, new RegExp(`name:\\s*'?${pkg.name}'?`));
});

test('exports 指向真实文件（入口 / 图标 / 语言包）', () => {
  for (const [key, rel] of Object.entries(pkg.exports)) {
    if (key.includes('*')) continue;
    assert.ok(existsSync(join(root, rel)), `${key} → ${rel} 不存在`);
  }
  assert.ok(pkg.exports['.'], '缺少入口导出');
  const entry = pkg.exports['.'];
  assert.ok(/host|index/.test(entry), `入口看起来不对：${entry}`);
});

test('插件入口导出 apply，注入 llm', async () => {
  const mod = await import(new URL(`../${pkg.exports['.']}`, import.meta.url));
  assert.equal(typeof mod.apply, 'function');
  assert.ok(Array.isArray(mod.inject), 'inject 应为数组');
  assert.ok(mod.inject.includes('llm'), '需要 ctx.llm');
});

test('语言包有 meta.title / meta.description', () => {
  for (const loc of ['zh', 'en']) {
    const meta = JSON.parse(readFileSync(join(root, 'locale', `${loc}.json`), 'utf8')).meta;
    assert.ok(meta.title && meta.description, `${loc} 缺 meta`);
  }
});

test('图标是 SVG 且不超 256KB', () => {
  const file = join(root, 'icon.svg');
  assert.ok(existsSync(file));
  assert.ok(statSync(file).size < 256 * 1024);
  assert.match(readFileSync(file, 'utf8').slice(0, 200), /<svg/);
});
