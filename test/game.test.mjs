// 她的小游戏：只测纯逻辑（浏览器那层在 tests 外面，用 .tmp 的冒烟脚本验）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAME_TTL, LEVELS, MAX_LEVEL, PLANTS, bestOf, currentLevel, gameEmotion, gameLine, gameTurnPrompt,
  lawnText, levelInfo, moveAllowed, noteGame, parseGameReaction, parseMove, plantIn, resultText,
  shouldPlay, unlockedPlants, waveInfo,
} from '../src/game.js';

const H = 3600e3;
const NOW = new Date(2026, 10, 22, 12, 0, 0).getTime();

test('指令：`[种:豌豆 3,2]` 落到第 3 行第 2 列（给她的图是 1 基）', () => {
  const m = parseMove('[种:豌豆 3,2]');
  assert.deepEqual(m, { kind: 'plant', plant: 'peashooter', row: 2, col: 1 });
});

test('指令：长名优先——「火豌豆」不会被「豌豆」抢走', () => {
  assert.equal(plantIn('种个火豌豆'), 'firepea');
  assert.equal(plantIn('种个豌豆'), 'peashooter');
  assert.equal(plantIn('寒冰射手放前面'), 'snowpea');
  assert.equal(parseMove('[种:火豌豆 1,9]').plant, 'firepea');
});

test('指令：[等] 就是等；认不出来返回 null（不替她瞎种）', () => {
  assert.deepEqual(parseMove('[等]'), { kind: 'wait' });
  assert.deepEqual(parseMove('先等等，攒点阳光'), { kind: 'wait' });
  assert.equal(parseMove('不知道种什么'), null);
  assert.equal(parseMove(''), null);
  assert.equal(parseMove('[种:豌豆 9,9]'), null, '出界的不算');
});

test('指令：行列表反了也认，只要有一组落在范围内', () => {
  assert.deepEqual(parseMove('[种:向日葵 2,4]'), { kind: 'plant', plant: 'sunflower', row: 1, col: 3 });
  assert.deepEqual(parseMove('[种:向日葵 2,6]'), { kind: 'plant', plant: 'sunflower', row: 1, col: 5 });
});

test('战况图：5 行 × 9 列，植物用短名，僵尸带行和位置，波次带这一波的数量', () => {
  const text = lawnText({
    sun: 175, wave: 7, maxWaves: 20, score: 1200, defeated: 23,
    plants: [{ row: 0, col: 0, type: 'sunflower' }, { row: 2, col: 3, type: 'peashooter' }],
    zombies: [{ row: 2, col: 8.4, type: 'bucket', health: 40 }, { row: 0, col: 5.1, type: 'normal', health: 10 }],
  });
  assert.match(text, /1\| 向日 · · · · · · · ·/);
  assert.match(text, /3\| · · · 豌豆/);
  assert.match(text, /僵尸：第1行 普通@第6列 血10；第3行 铁桶@第9列 血40/);
  assert.match(text, /阳光 175/);
  assert.match(text, /第 7\/20 波（这一波约 6 个，每 2.3 秒一个）/);
  assert.match(text, /买得起：.*坚果/);
});

test('波次难度：照引擎公式算——越往后越多越密，封顶 15 个/1 秒', () => {
  assert.deepEqual(waveInfo(1), { count: 3, gapSec: 2.9 });
  assert.deepEqual(waveInfo(10), { count: 8, gapSec: 2 });
  assert.deepEqual(waveInfo(20), { count: 13, gapSec: 1 });
  assert.deepEqual(waveInfo(99), { count: 15, gapSec: 1 });
});

test('五关：波数一关一关涨，植物一关一关解锁，第五关是 20 波全植物', () => {
  assert.equal(LEVELS.length, 5);
  assert.deepEqual(LEVELS.map((l) => l.waves), [2, 4, 7, 12, 20]);
  assert.deepEqual(levelInfo(1).plants, ['sunflower', 'peashooter'], '第一关只有两种');
  assert.equal(levelInfo(5).plants.length, Object.keys(PLANTS).length, '第五关全给');
  // 后面几关不能比前面少植物
  for (let i = 1; i < LEVELS.length; i += 1) {
    for (const k of LEVELS[i - 1].plants) assert.ok(LEVELS[i].plants.includes(k), `第 ${i + 1} 关不该丢 ${k}`);
  }
  assert.equal(levelInfo(1).tip.includes('第一关'), true, '第一关是教学关');
});

test('进度：过一关解锁下一关；没过的关一直重打；五关过了继续刷第五关', () => {
  assert.equal(currentLevel({}), 1);
  assert.equal(currentLevel({ cleared: [1] }), 2);
  assert.equal(currentLevel({ cleared: [1, 2, 3] }), 4);
  assert.equal(currentLevel({ cleared: [1, 2, 3, 4, 5] }), MAX_LEVEL);
  assert.deepEqual(unlockedPlants({ cleared: [1, 2] }), LEVELS[2].plants);
  assert.equal(moveAllowed({}, { kind: 'plant', plant: 'peashooter' }), true);
  assert.equal(moveAllowed({}, { kind: 'plant', plant: 'wallnut' }), false, '第一关没有坚果');
  assert.equal(moveAllowed({ cleared: [1] }, { kind: 'plant', plant: 'wallnut' }), true, '第二关解锁');
  assert.equal(moveAllowed({ cleared: [1] }, { kind: 'wait' }), true);
});

test('回合提示：按当前关给植物和波数，第一关带一句教学', () => {
  const p1 = gameTurnPrompt({ state: {}, minutesLeft: 10 });
  assert.match(p1, /第 1 关，打 2 波/);
  assert.match(p1, /向日葵50 豌豆100/);
  assert.doesNotMatch(p1, /坚果/, '第一关没有坚果');
  assert.match(p1, /先种向日葵攒阳光/, '教学关要给一句');
  assert.match(p1, /铁桶40/, '僵尸血量照给');

  const p4 = gameTurnPrompt({ state: { cleared: [1, 2, 3], top: { 4: { wave: 9 } } }, minutesLeft: 10 });
  assert.match(p4, /第 4 关，打 12 波/);
  assert.match(p4, /双发200/);
  assert.match(p4, /这一关你最好打到第 9 波/);
  assert.doesNotMatch(p4, /先种向日葵攒阳光/, '只有教学关才教');
});

test('局后感想：引了战况里的字才算有锚点，锚不上不推情绪', () => {
  const material = resultText({ wave: 12, maxWaves: 20, score: 3400, defeated: 37 }, 9, 3);
  const ok = parseGameReaction('那条道被铁桶撑爆的时候我还在攒阳光，「打掉 37 个」也救不回来。[玩:闷 2]', material);
  assert.equal(ok.anchored, true);
  assert.equal(ok.label, '闷');
  assert.equal(ok.intensity, 2);
  assert.match(ok.thought, /撑爆/);
  assert.doesNotMatch(ok.thought, /\[玩/);
  assert.ok(gameEmotion(ok));

  const fake = parseGameReaction('我觉得这游戏真好玩，打得我热血沸腾。[玩:爽 3]', material);
  assert.equal(fake.anchored, false, '引不出战况里的东西就是在演');
  assert.equal(gameEmotion(fake), null, '没锚点不许进情绪');
  assert.match(fake.thought, /热血沸腾/, '感想本身还是她的话，照存');
});

test('被切断的 `[玩` 残片要剥掉，不能留在感想里', () => {
  const r = parseGameReaction('打到第 12 波就没了，有点闷 [玩', '打到第 12/20 波');
  assert.doesNotMatch(r.thought, /\[玩/);
});

test('记一局：赢了写进过关列表、解锁下一关；输了原地重打', () => {
  let st = noteGame({}, { now: NOW, day: '2026-11-22', snap: { wave: 2, maxWaves: 2, victory: true, score: 800, defeated: 7 }, minutes: 3 });
  assert.equal(st.last.level, 1);
  assert.deepEqual(st.cleared, [1]);
  assert.equal(st.level, 2, '下一关是第 2 关');
  assert.equal(bestOf(st, 1).wave, 2);
  assert.equal(bestOf(st, 2), null, '第二关还没成绩');

  st = noteGame(st, { now: NOW + 26 * H, day: '2026-11-23', snap: { wave: 3, maxWaves: 4, score: 900, defeated: 9 }, minutes: 5 });
  assert.equal(st.last.level, 2);
  assert.deepEqual(st.cleared, [1], '输了不解锁');
  assert.equal(st.level, 2, '还在第 2 关');
  assert.equal(bestOf(st, 2).wave, 3);
});

test('每关最好成绩分开记：第五关的成绩不压第一关', () => {
  let st = noteGame({}, { now: NOW, day: 'd', snap: { wave: 2, maxWaves: 2, victory: true } });
  st = noteGame(st, { now: NOW + H, day: 'd', snap: { wave: 4, maxWaves: 4, victory: true } });
  assert.equal(bestOf(st, 1).wave, 2, '第一关还是 2 波');
  assert.equal(bestOf(st, 2).wave, 4, '第二关记自己的');
  assert.equal(bestOf(st, 3), null, '第三关还没打过');
});

test('通关算更好的成绩：同样波数，赢了优先', () => {
  let st = noteGame({}, { now: NOW, day: 'd', snap: { wave: 2, maxWaves: 2, victory: false, score: 5000 } });
  st = noteGame(st, { now: NOW + H, day: 'd', snap: { wave: 2, maxWaves: 2, victory: true, score: 10 } });
  assert.equal(bestOf(st, 1).victory, true);
  assert.equal(bestOf(st, 1).score, 10);
});

test('她能说出口的那一行：第几关、波数、原话、过了哪几关；过了 48 小时就闭嘴', () => {
  let st = noteGame({}, {
    now: NOW, day: '2026-11-22',
    snap: { wave: 2, maxWaves: 2, victory: true, score: 800, defeated: 7 },
    minutes: 3,
    reaction: { thought: '这只复刻的向日葵居然也射击', label: '尬', intensity: 1, anchor: '第 1 关（2 波）', anchored: true },
  });
  st = noteGame(st, {
    now: NOW + H, day: '2026-11-22',
    snap: { wave: 4, maxWaves: 4, victory: true },
    reaction: { thought: '这次守住了', label: '爽', intensity: 2, anchor: '第 2 关（4 波）', anchored: true },
  });
  const line = gameLine(st, NOW + 2 * H);
  assert.match(line.text, /植物大战僵尸/);
  assert.match(line.text, /第 2 关（4 波）/);
  assert.match(line.text, /过了/);
  assert.match(line.text, /这次守住了/);
  assert.match(line.text, /已经过了第 1、2 关/);
  assert.equal(line.ttl, GAME_TTL);
  assert.equal(gameLine(st, NOW + H + GAME_TTL + 1).text, '', '过期了就不许再说「最近在打」');
  assert.equal(gameLine({}, NOW).text, '');
});

test('闸门：他安静够久、今天没玩过、心情还行才开一局', () => {
  const base = { now: NOW, lastUserAt: NOW - H, lastPlayAt: 0, playsToday: 0, mood: 0.5 };
  assert.equal(shouldPlay(base), true);
  assert.equal(shouldPlay({ ...base, lastUserAt: NOW - 10 * 60e3 }), false, '他十分钟前刚说过话');
  assert.equal(shouldPlay({ ...base, playsToday: 1 }), false, '今天已经玩过');
  assert.equal(shouldPlay({ ...base, mood: 0.1 }), false, '心情太差');
  assert.equal(shouldPlay({ ...base, lastUserAt: 0 }), false, '从没说过话');
  assert.equal(shouldPlay({ ...base, lastPlayAt: NOW - 10 * 60e3 }), false, '刚玩完');
});

test('战绩文字只有真数字，并且带上第几关', () => {
  assert.equal(
    resultText({ wave: 12, maxWaves: 20, score: 3400, defeated: 37 }, 9, 5),
    '第 5 关（20 波），打到第 12/20 波，没挡住，分数 3400，打掉 37 个僵尸，玩了 9 分钟',
  );
  assert.match(resultText({ wave: 4, maxWaves: 4, victory: true, score: 1, defeated: 2 }, 0, 2), /第 2 关（4 波）.*全挡回去了/);
});
