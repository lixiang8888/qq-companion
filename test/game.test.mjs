// 她的小游戏：只测纯逻辑（浏览器那层在 tests 外面，用 .tmp 的冒烟脚本验）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAME_TTL, PLANTS, gameEmotion, gameLine, gameTurnPrompt, lawnText, noteGame, parseGameReaction,
  parseMove, plantIn, resultText, shouldPlay,
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
  // 2,4 两种解释都合法，取第一种；换成 6,2 时只能解释成 行2 列6
  assert.deepEqual(parseMove('[种:向日葵 2,6]'), { kind: 'plant', plant: 'sunflower', row: 1, col: 5 });
});

test('战况图：5 行 × 9 列，植物用短名，僵尸带行和位置', () => {
  const text = lawnText({
    sun: 175, wave: 7, maxWaves: 20, score: 1200, defeated: 23,
    plants: [{ row: 0, col: 0, type: 'sunflower' }, { row: 2, col: 3, type: 'peashooter' }],
    zombies: [{ row: 2, col: 8.4, type: 'bucket', health: 40 }, { row: 0, col: 5.1, type: 'normal', health: 10 }],
  });
  assert.match(text, /1\| 向日 · · · · · · · ·/);
  assert.match(text, /3\| · · · 豌豆/);
  assert.match(text, /僵尸：第1行 普通@第6列 血10；第3行 铁桶@第9列 血40/);
  assert.match(text, /阳光 175/);
  assert.match(text, /第 7\/20 波/);
  assert.match(text, /买得起：.*坚果/);
});

test('局后感想：引了战况里的字才算有锚点，锚不上不推情绪', () => {
  const material = '打到第 12/20 波，没挡住，分数 3400，打掉 37 个僵尸，玩了 9 分钟';
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

test('记一局：最好成绩按波数比，最近留 5 局；没锚点的标签清零', () => {
  let st = noteGame({}, { now: NOW, day: '2026-11-22', snap: { wave: 12, maxWaves: 20, score: 3400, defeated: 37 }, minutes: 9, reaction: { thought: '有点闷', label: '闷', intensity: 2, anchor: '打掉 37 个', anchored: true } });
  assert.equal(st.best.wave, 12);
  assert.equal(st.last.label, '闷');
  assert.equal(st.plays, 1);

  st = noteGame(st, { now: NOW + 26 * H, day: '2026-11-23', snap: { wave: 8, maxWaves: 20, score: 900, defeated: 10 }, reaction: { thought: '演一下', label: '爽', intensity: 3, anchor: '', anchored: false } });
  assert.equal(st.best.wave, 12, '低的一局不改最好成绩');
  assert.equal(st.last.label, '', '没锚点的标签清零');
  assert.equal(st.recent.length, 2);
  assert.equal(st.recent[1].wave, 12, '最近的排前面');

  for (let i = 0; i < 6; i += 1) st = noteGame(st, { now: NOW + (30 + i) * H, day: 'x', snap: { wave: 3, maxWaves: 20 } });
  assert.equal(st.recent.length, 5);
});

test('通关算更好的成绩：同样波数，赢了优先', () => {
  let st = noteGame({}, { now: NOW, day: 'd', snap: { wave: 20, maxWaves: 20, victory: false, score: 5000 } });
  assert.equal(st.best.victory, false);
  st = noteGame(st, { now: NOW + 40 * 3600e3, day: 'd', snap: { wave: 20, maxWaves: 20, victory: true, score: 6000 } });
  assert.equal(st.best.victory, true);
  assert.equal(st.best.score, 6000);
});

test('她能说出口的那一行：有战绩、有原话、有最好成绩；过了 48 小时就闭嘴', () => {
  const st = noteGame({}, {
    now: NOW, day: '2026-11-22',
    snap: { wave: 12, maxWaves: 20, score: 3400, defeated: 37 },
    minutes: 9,
    reaction: { thought: '那条道被撑爆了', label: '闷', intensity: 2, anchor: '打掉 37 个', anchored: true },
  });
  const line = gameLine(st, NOW + 2 * H);
  assert.match(line.text, /植物大战僵尸/);
  assert.match(line.text, /第 12\/20 波/);
  assert.match(line.text, /没挡住/);
  assert.match(line.text, /那条道被撑爆了/);
  assert.equal(line.ttl, GAME_TTL);
  assert.equal(gameLine(st, NOW + GAME_TTL + 1).text, '', '过期了就不许再说「最近在打」');
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

test('回合提示：给价格和僵尸血量，但不替她拿主意', () => {
  const p = gameTurnPrompt({ best: { wave: 9 }, minutesLeft: 20 });
  assert.match(p, /向日葵50/);
  assert.match(p, /铁桶40/);
  assert.match(p, /\[种:豌豆 3,2\]/);
  assert.match(p, /最好成绩是第 9 波/);
  assert.doesNotMatch(p, /建议|应该先/, '不教她打');
});

test('战绩文字只有真数字', () => {
  assert.equal(
    resultText({ wave: 12, maxWaves: 20, score: 3400, defeated: 37 }, 9),
    '打到第 12/20 波，没挡住，分数 3400，打掉 37 个僵尸，玩了 9 分钟',
  );
  assert.match(resultText({ wave: 20, maxWaves: 20, victory: true, score: 1, defeated: 2 }), /全挡回去了/);
  assert.equal(Object.keys(PLANTS).length, 9);
});
