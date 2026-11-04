// 装没装上：四处证据缺一不可。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkInstalled } from '../src/install-check.js';

const NAME = 'qq-companion';

function profile({ dep = true, bundle = true, patch = true, files = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqc-prof-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: dep ? { [NAME]: 'file:../qq-companion' } : {},
    dsh: { profile: { bundles: bundle ? [NAME] : [] } },
  }));
  if (patch) writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${NAME}\n      name: ${NAME}\n`);
  if (files) {
    mkdirSync(join(dir, 'node_modules', NAME), { recursive: true });
    writeFileSync(join(dir, 'node_modules', NAME, 'package.json'), JSON.stringify({
      name: NAME, type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }));
  }
  return dir;
}

test('四处齐全 → 通过', () => {
  const r = checkInstalled({ profileDir: profile() });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
});

test('只装了包、没加进 bundles → 明确报「不会加载」', () => {
  const r = checkInstalled({ profileDir: profile({ bundle: false }) });
  assert.equal(r.ok, false);
  const c = r.checks.find((x) => x.label === 'bundle 已选择');
  assert.equal(c.ok, false);
});

test('patch 里没有行 → 装了也不挂载', () => {
  const r = checkInstalled({ profileDir: profile({ patch: false }) });
  assert.equal(r.checks.find((x) => x.label === 'patch 行').ok, false);
});

test('node_modules 里没有实体 → 报缺', () => {
  const r = checkInstalled({ profileDir: profile({ files: false }) });
  assert.equal(r.checks.find((x) => x.label === '包实体存在').ok, false);
});

test('profile 路径不存在 → 不崩，报不存在', () => {
  const r = checkInstalled({ profileDir: join(tmpdir(), 'definitely-not-here-xyz') });
  assert.equal(r.ok, false);
  assert.equal(r.checks[0].ok, false);
});
