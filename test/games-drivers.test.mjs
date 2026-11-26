// 三款结构化游戏的驱动里那些纯逻辑：指令解析、棋盘文字、结束判定、局后材料与存档。
import test from 'node:test';
import assert from 'node:assert/strict';
import { create as createPvz } from '../src/games/pvz.js';
import { board2048, create as create2048, parse2048 } from '../src/games/g2048.js';
import { boardText, create as createSokoban, parseSokoban } from '../src/games/sokoban.js';

// ---- PvZ ----

test('PvZ 驱动：解析种植/等待/不玩；没解锁的植物不落子；局后材料带真关卡', async () => {
  const spec = createPvz({ stepMs: 2000, maxDecisions: 20 });
  assert.equal(spec.id, 'pvz');
  assert.equal(spec.stepMs, 2000);
  assert.deepEqual(spec.parse('[种:豌豆 3,2]'), { kind: 'plant', plant: 'peashooter', row: 2, col: 1 });
  assert.deepEqual(spec.parse('先等一等'), { kind: 'wait' });
  assert.deepEqual(spec.parse('不玩了'), { kind: 'quit' });

  const calls = [];
  const browser = { async evaluate(expr) { calls.push(expr); return 'ok'; } };
  const locked = await spec.apply({ browser, action: { kind: 'plant', plant: 'snowpea', row: 0, col: 0 }, progress: {} });
  assert.equal(locked.ok, false);
  assert.match(locked.note, /要后面几关才有/);
  assert.equal(calls.length, 0, '没解锁的植物连页面都不碰');

  const ok = await spec.apply({ browser, action: { kind: 'plant', plant: 'peashooter', row: 1, col: 2 }, progress: {} });
  assert.equal(ok.ok, true);
  assert.match(calls[0], /plantCard/);

  const prompt = spec.prompt({ board: '棋盘', progress: {}, leftMs: 5 * 60e3 });
  assert.match(prompt.instructions, /植物大战僵尸/);
  assert.match(prompt.user, /这一回合做什么/);

  const out = spec.finish({
    state: { ready: true, wave: 2, maxWaves: 2, victory: true, score: 5000, defeated: 10 },
    progress: {}, minutes: 3, notes: [], t0: 1000, t1: 2000,
  });
  assert.match(out.facts, /第 1 关/);
  assert.match(out.facts, /分数 5000/);
  assert.equal(out.victory, true);
  assert.deepEqual(out.progress.cleared, [1]);
  assert.equal(out.progress.level, 2);

  assert.deepEqual(spec.done({ over: false, victory: false }), { over: false, victory: false });
  assert.deepEqual(spec.done({ over: true, victory: true }), { over: true, victory: true });
});

// ---- 2048 ----

test('2048 驱动：方向解析、棋盘还原、结束判定、分数进存档', () => {
  assert.deepEqual(parse2048('[按:左]'), { kind: 'move', dir: '左', key: 'ArrowLeft' });
  assert.deepEqual(parse2048('往上'), { kind: 'move', dir: '上', key: 'ArrowUp' });
  assert.deepEqual(parse2048('不推了，不玩了'), { kind: 'quit' });
  assert.equal(parse2048('嗯？'), null);

  const cells = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => null));
  cells[0][0] = { value: 2 };
  cells[1][0] = { value: 4 };
  cells[3][2] = { value: 1024 };
  assert.equal(board2048({ cells }), '2 4 . .\n. . . .\n. . . 1024\n. . . .');

  const spec = create2048();
  assert.deepEqual(spec.done({ won: true, over: false }), { over: true, victory: true });
  assert.deepEqual(spec.done({ won: false, over: true }), { over: true, victory: false });
  assert.deepEqual(spec.done({ won: false, over: false }), { over: false });

  const out = spec.finish({
    state: { score: 1024, maxTile: 256, won: false, over: true },
    progress: { best: 512 },
    decisions: 40, minutes: 6,
  });
  assert.match(out.facts, /推了 40 手/);
  assert.match(out.facts, /最后 1024 分/);
  assert.match(out.facts, /推死了/);
  assert.equal(out.progress.best, 1024);
  assert.equal(out.progress.plays, 1);
});

// ---- 推箱子 ----

test('推箱子驱动：指令解析、标准字符画、过关后进下一关', () => {
  assert.deepEqual(parseSokoban('[走:左]'), { kind: 'move', dir: '左', key: 'ArrowLeft' });
  assert.deepEqual(parseSokoban('撤销'), { kind: 'undo', key: 'U' });
  assert.deepEqual(parseSokoban('重来一次'), { kind: 'restart', key: 'R' });
  assert.deepEqual(parseSokoban('不推了'), { kind: 'quit' });
  assert.equal(parseSokoban('嗯？'), null);

  // 3×2：墙 目标 箱子(在目标上) / 玩家 目标 地板
  const cells = [
    { wall: true }, { goal: true, box: true, on: true }, { wall: true },
    { hero: true }, { goal: true }, {},
  ];
  assert.equal(boardText(cells, 3), '#*#\n@. ');
  assert.equal(boardText([], 0), '');

  const spec = createSokoban();
  assert.deepEqual(spec.done({ solved: true }), { over: true, victory: true });
  const out = spec.finish({
    state: { solved: true, moves: 12, pushes: 5, boxesOnGoal: 2, boxesTotal: 2, level: 2 },
    progress: { level: 2, wins: 0 },
    quit: false,
  });
  assert.match(out.facts, /第 2\/30 关/);
  assert.match(out.facts, /走了 12 步/);
  assert.equal(out.victory, true);
  assert.equal(out.progress.level, 3);
  assert.equal(out.progress.wins, 1);
});
