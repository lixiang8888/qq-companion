// 安装形态体检：把包按 profile 的方式放到 node_modules 里，再按包名解析。
// 这不能代替真机安装，但能提前抓住「exports 写错 / 入口不是 ESM / 包名对不上」这类装不上还有救的错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function fakeProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-profile-'));
  const target = join(dir, 'node_modules', pkg.name);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, 'src'), join(target, 'src'), { recursive: true });
  cpSync(join(root, 'package.json'), join(target, 'package.json'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake-profile', type: 'module', private: true }));
  return { dir, target };
}

test('按包名能解析到入口，且入口导出 apply', async () => {
  const { dir } = fakeProfile();
  const require = createRequire(join(dir, 'package.json'));
  const resolved = require.resolve(pkg.name);
  assert.ok(resolved.endsWith('host.js'), `解析到 ${resolved}`);
  const mod = await import(pathToFileURL(resolved).href);
  assert.equal(typeof mod.apply, 'function');
  assert.equal(typeof mod.createHost, 'function');
  assert.ok(mod.inject.includes('llm'));
});

test('入口不依赖 @deepseek-ai/* 运行时包（profile 里解析不到）', async () => {
  const { dir } = fakeProfile();
  const require = createRequire(join(dir, 'package.json'));
  const mod = await import(pathToFileURL(require.resolve(pkg.name)).href);
  assert.ok(mod, '能加载就说明没有外部依赖被顶层 import');
});
