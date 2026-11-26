// 游戏目录：扫 assets/games/<id>/game.json，校验后交给 host。
//
// 约定写在 docs/superpowers/plans/2026-11-26-games-platform.md：
// 每款游戏一个目录、一份清单；structured 游戏必须有同 id 的驱动代码，
// vision 游戏必须有「怎么开始 / 怎么算赢」两条页面表达式。
// 一个包坏了不应该拖垮别的游戏——跳过它、记一条日志。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const KINDS = new Set(['structured', 'vision']);

/** 清单校验：返回规整后的游戏对象，不合格返回 null。 */
export function validateManifest(raw = {}, { root = '', drivers = {}, exists = existsSync } = {}) {
  const id = String(raw.id || '');
  if (!ID_RE.test(id)) return null;
  const title = String(raw.title || '').trim();
  if (!title) return null;
  const kind = String(raw.kind || '');
  if (!KINDS.has(kind)) return null;
  const entry = String(raw.entry || '').replace(/^\/+/, '');
  if (!entry) return null;
  if (root && exists && !exists(join(root, entry))) return null;
  if (kind === 'structured' && !drivers[id]) return null;
  if (kind === 'vision') {
    if (!String(raw.start || '').trim()) return null;
    if (!String(raw.done || '').trim()) return null;
  }
  return {
    id,
    title,
    kind,
    entry,
    ready: String(raw.ready || '').trim(),
    start: String(raw.start || '').trim(),
    done: String(raw.done || '').trim(),
    read: String(raw.read || '').trim(),
    summary: String(raw.summary || '').trim(),
    controls: String(raw.controls || '').trim(),
    license: String(raw.license || '').trim(),
    source: String(raw.source || '').trim(),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 100,
    driver: kind === 'structured' ? drivers[id] : null,
  };
}

/**
 * 扫目录。返回按 order、再按 id 排好的游戏列表。
 * 注入 readdir/read/stat 是为了测试能喂假目录。
 */
export function readCatalog({
  root,
  drivers = {},
  log = null,
  readdir = readdirSync,
  read = (p) => readFileSync(p, 'utf8'),
  stat = statSync,
  exists = existsSync,
} = {}) {
  if (!root) return [];
  let names = [];
  try { names = readdir(root); } catch { return []; }
  const out = [];
  for (const name of [...names].sort()) {
    if (!name || name.startsWith('.')) continue;
    const dir = join(root, name);
    try { if (!stat(dir).isDirectory()) continue; } catch { continue; }
    const file = join(dir, 'game.json');
    if (!exists(file)) continue;
    let raw;
    try { raw = JSON.parse(read(file)); } catch (e) {
      log?.warn?.(`游戏包 ${name} 的清单读不了：${e.message}`);
      continue;
    }
    const game = validateManifest(raw, { root, drivers, exists });
    if (!game) {
      log?.warn?.(`游戏包 ${name} 不合格（缺字段 / 缺入口 / 缺驱动），跳过`);
      continue;
    }
    out.push(game);
  }
  return out.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

export function gameById(games = [], id = '') {
  return games.find((g) => g.id === id) || null;
}
