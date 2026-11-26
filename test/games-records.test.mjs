// 游戏账本：旧文件迁移、记一局、注入用的那一行、面板进度。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_TTL, createRecords, gameLine, legacyEntry, legacyFacts, libraryLines, migrateRecords, noteSession,
} from '../src/games/records.js';

const T = new Date(2026, 10, 22, 12, 0, 0).getTime();
const H = 3600e3;

test('旧账本迁移：根上的关卡/最好成绩变成 pvz 存档，last 变成通用一条', () => {
  const old = {
    at: T, day: '2026-11-22', plays: 7, level: 2, cleared: [1],
    top: { 1: { wave: 2, victory: true, score: 5000, at: T } },
    last: { at: T, day: '2026-11-22', level: 1, wave: 2, maxWaves: 2, victory: true, score: 5000, defeated: 10, minutes: 3, thought: '守住了', label: '爽', intensity: 2, anchor: '第 1 关（2 波）' },
    recent: [],
  };
  const st = migrateRecords(old);
  assert.equal(st.version, 2);
  assert.equal(st.last.game, 'pvz');
  assert.equal(st.last.title, '植物大战僵尸');
  assert.match(st.last.facts, /第 1 关（2 波）/);
  assert.match(st.last.facts, /打到第 2\/2 波/);
  assert.match(st.last.facts, /分数 5000/);
  assert.equal(st.last.label, '爽');
  assert.deepEqual(st.library.pvz.cleared, [1]);
  assert.equal(st.library.pvz.level, 2);
  assert.equal(st.library.pvz.top[1].score, 5000);
  // 再迁一次形状不变
  assert.deepEqual(migrateRecords(st), st);
});

test('legacyFacts 只写这一局真发生过的数', () => {
  assert.equal(legacyFacts({}), '');
  assert.match(legacyFacts({ level: 3, wave: 7, maxWaves: 7, victory: true, score: 1200, defeated: 31, minutes: 5 }),
    /第 3 关（7 波），打到第 7\/7 波，把僵尸全挡回去了，分数 1200，打掉 31 个僵尸，玩了 5 分钟/);
  assert.ok(legacyEntry({ at: T, wave: 1 }));
  assert.equal(legacyEntry({ wave: 1 }), null);
});

test('记一局：last/recent/plays 往前走，每款游戏的存档各归各', () => {
  let st = createRecords();
  st = noteSession(st, {
    game: 'g2048', title: '2048', at: T, day: '2026-11-22',
    facts: '《2048》玩了 5 分钟，推了 40 手，最后 1024 分',
    thought: '还行', label: '爽', intensity: 2, anchor: '1024',
    progress: { best: 1024, plays: 1 },
  });
  assert.equal(st.plays, 1);
  assert.equal(st.last.game, 'g2048');
  assert.equal(st.library.g2048.best, 1024);
  assert.equal(st.library.g2048.title, '2048');
  assert.equal(st.recent.length, 1);

  st = noteSession(st, {
    game: 'pvz', title: '植物大战僵尸', at: T + H, facts: '打了第一关', progress: { level: 2, cleared: [1] },
  });
  assert.equal(st.plays, 2);
  assert.equal(st.last.game, 'pvz');
  assert.equal(st.library.pvz.level, 2);
  assert.equal(st.library.g2048.best, 1024, '另一款的存档不能丢');
  assert.equal(st.recent.length, 2);
});

test('她最近在玩的那一行：带标题/战绩/原话，48 小时后闭嘴', () => {
  let st = createRecords();
  st = noteSession(st, { game: 'sokoban', title: '推箱子', at: T, facts: '过了第 2 关', thought: '推箱子比想象中难' });
  const line = gameLine(st, T + 2 * H);
  assert.match(line.text, /《推箱子》/);
  assert.match(line.text, /过了第 2 关/);
  assert.match(line.text, /推箱子比想象中难/);
  assert.equal(line.ttl, SESSION_TTL);
  assert.equal(gameLine(st, T + SESSION_TTL + 1).text, '');
  assert.equal(gameLine({}, T).text, '');
});

test('面板进度：每款只说真的数，没进度的款不硬编', () => {
  let st = createRecords();
  st = noteSession(st, { game: 'pvz', title: '植物大战僵尸', at: T, facts: 'x', progress: { level: 2, cleared: [1] } });
  st = noteSession(st, { game: 'g2048', title: '2048', at: T, facts: 'x', progress: { best: 512 } });
  st = noteSession(st, { game: 'sokoban', title: '推箱子', at: T, facts: 'x', progress: { level: 3 } });
  st = noteSession(st, { game: 'lightsout', title: '点灯', at: T, facts: 'x', progress: { wins: 2 } });
  const lines = libraryLines(st);
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.match(byId.pvz.text, /过了第 1 关/);
  assert.match(byId.g2048.text, /最高 512/);
  assert.match(byId.sokoban.text, /第 3 关/);
  assert.match(byId.lightsout.text, /赢过 2 次/);
});
