// 装没装上：只读 profile 的清单，回答「DSH 会不会加载到这个 bundle」。
//
// 真机最常见的失败不是代码错，而是「显示装好了，其实 bundle 列表里没有」。
// 这里把四处证据都看一遍：依赖、bundles 列表、patch 行、node_modules 实体。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

export const PACKAGE_NAME = 'qq-companion';

/**
 * @param {{profileDir: string, name?: string}} o
 */
export function checkInstalled({ profileDir, name = PACKAGE_NAME } = {}) {
  const checks = [];
  const add = (label, ok, detail = '') => checks.push({ label, ok, detail });

  if (!profileDir || !existsSync(profileDir)) {
    add('profile 目录存在', false, profileDir || '没给路径');
    return { ok: false, checks };
  }
  add('profile 目录存在', true, profileDir);

  const pkg = readJson(join(profileDir, 'package.json'));
  if (!pkg) {
    add('profile package.json 可读', false, '文件缺失或不是 JSON');
  } else {
    add('profile package.json 可读', true, pkg.name || '');
    const dep = pkg.dependencies?.[name];
    add('依赖已声明', Boolean(dep), dep || 'package.json 的 dependencies 里没有它');
    const bundles = pkg.dsh?.profile?.bundles || [];
    add('bundle 已选择', bundles.includes(name), bundles.join(', ') || 'dsh.profile.bundles 为空');
  }

  const patchFile = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(patchFile)) {
    add('patch 行', false, 'cordis.patch.yml 不存在');
  } else {
    const text = readFileSync(patchFile, 'utf8');
    const hasRow = new RegExp(`id:\\s*${name}\\b`).test(text) || new RegExp(`name:\\s*'?${name}'?`).test(text);
    add('patch 行', hasRow, hasRow ? '找到挂载行' : 'patch 里没有这个 bundle 的行（就算装了也不会挂载）');
  }

  const installed = join(profileDir, 'node_modules', name);
  if (!existsSync(installed)) {
    add('包实体存在', false, installed);
  } else {
    const manifest = readJson(join(installed, 'package.json'));
    add('包实体存在', Boolean(manifest), installed);
    add('包名一致', manifest?.name === name, manifest?.name || '读不到 name');
    add('声明了 bundle patch', Boolean(manifest?.dsh?.bundle?.patch), manifest?.dsh?.bundle?.patch || 'package.json 缺 dsh.bundle.patch');
  }

  return { ok: checks.every((c) => c.ok), checks };
}
