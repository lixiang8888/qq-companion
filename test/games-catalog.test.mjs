// 游戏目录：扫包、校验、按 order 排；以及「她这轮玩哪款」的不随机选择。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readCatalog, validateManifest } from '../src/games/catalog.js';
import { pickGame } from '../src/games/pick.js';

const ROOT = join('C:', 'fake-games');
const p = (...xs) => join(ROOT, ...xs);
const DRIVERS = { pvz: {}, g2048: {} };

function fakeFs(manifests, entries) {
  const ids = Object.keys(manifests);
  const files = new Set([...ids.map((id) => p(id, 'game.json')), ...entries]);
  return {
    readdir: () => [...ids, 'notes.txt'],
    stat: (path) => ({ isDirectory: () => ids.some((id) => path === p(id)) }),
    read: (path) => JSON.stringify(manifests[ids.find((id) => path === p(id, 'game.json'))]),
    exists: (path) => files.has(path),
  };
}

const pvz = { id: 'pvz', title: '植物大战僵尸', kind: 'structured', entry: 'pvz/index.html', order: 1 };
const g2048 = { id: 'g2048', title: '2048', kind: 'structured', entry: 'g2048/index.html', order: 2 };
const lights = { id: 'lightsout', title: '点灯', kind: 'vision', entry: 'lightsout/index.html', start: 'x()', done: 'y()', order: 3 };
const noDriver = { id: 'weird', title: '没驱动', kind: 'structured', entry: 'weird/index.html' };
const noEntry = { id: 'ghost', title: '没入口', kind: 'structured', entry: 'ghost/missing.html' };

test('目录：合格的包按 order 排好，坏的跳过不拖垮别的', () => {
  const manifests = { pvz, g2048, lightsout: lights, weird: noDriver, ghost: noEntry };
  const fs = fakeFs(manifests, [
    p('pvz', 'index.html'), p('g2048', 'index.html'), p('lightsout', 'index.html'),
    p('weird', 'index.html'),
  ]);
  const list = readCatalog({ root: ROOT, drivers: DRIVERS, ...fs });
  assert.deepEqual(list.map((g) => g.id), ['pvz', 'g2048', 'lightsout']);
  assert.equal(list[0].driver, DRIVERS.pvz);
  assert.equal(list[2].driver, null, '看屏游戏不需要代码驱动');
});

test('清单校验：缺字段/怪 id/没开始与结束判据都不收', () => {
  const exists = () => true;
  assert.equal(validateManifest({ ...pvz, id: 'Bad Id' }, { drivers: DRIVERS, exists }), null);
  assert.equal(validateManifest({ ...pvz, title: '' }, { drivers: DRIVERS, exists }), null);
  assert.equal(validateManifest({ ...pvz, kind: 'magic' }, { drivers: DRIVERS, exists }), null);
  assert.equal(validateManifest({ ...pvz, entry: '' }, { drivers: DRIVERS, exists }), null);
  assert.equal(validateManifest(noDriver, { drivers: DRIVERS, exists }), null, '结构化游戏没驱动就不收');
  assert.equal(validateManifest({ ...lights, done: '' }, { drivers: DRIVERS, exists }), null, '看屏游戏没结束判据不收');
  assert.ok(validateManifest(pvz, { drivers: DRIVERS, exists }));
});

test('她玩哪款：账本里有目标先玩那款；否则最久没玩的；拿不到看图就不选看屏游戏', () => {
  const games = readCatalog({
    root: ROOT, drivers: DRIVERS,
    ...fakeFs({ pvz, g2048, lightsout: lights }, [p('pvz', 'index.html'), p('g2048', 'index.html'), p('lightsout', 'index.html')]),
  });
  assert.equal(pickGame(games, { library: {}, hasVision: true }).id, 'pvz', '都没玩过：按目录顺序');
  assert.equal(pickGame(games, { library: { pvz: { at: 100 }, g2048: { at: 50 } }, hasVision: true }).id, 'lightsout');
  assert.equal(pickGame(games, { library: { pvz: { at: 100 }, g2048: { at: 50 } }, hasVision: false }).id, 'g2048', '看屏游戏先排除');
  assert.equal(pickGame(games, { library: {}, prefer: 'g2048', hasVision: true }).id, 'g2048', '有目标先做目标');
  assert.equal(pickGame(games, { library: {}, prefer: 'lightsout', hasVision: false }).id, 'pvz', '目标那款现在玩不了就按轮换');
  assert.equal(pickGame([], { hasVision: true }), null);
});
