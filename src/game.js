// 她自己的小游戏：《植物大战僵尸》MIT 复刻版（assets/pvz/，见 THIRD_PARTY_NOTICES.md）。
//
// 真游戏在浏览器里跑，host 用 CDP 驱动（src/pvz.js）；这里只有纯逻辑：
// 战况画成文字、解析她的指令、把这一局记下来、拼出注入她的那一行。
// 纯函数，离线可测——浏览器那层永远测不进去，所以边界必须在这里收紧。

import { anchorOf, reactionEmotion } from './novel.js';

export const ROWS = 5;
export const COLS = 9;

/** 复刻版的实际数值（从 assets/pvz/index.html 的 plantTypes 抄的，不是元版）。 */
export const PLANTS = {
  sunflower: { name: '向日葵', cost: 50 },
  peashooter: { name: '豌豆', cost: 100 },
  repeater: { name: '双发', cost: 200 },
  snowpea: { name: '寒冰', cost: 175 },
  wallnut: { name: '坚果', cost: 50 },
  chomper: { name: '大嘴花', cost: 150 },
  threepeater: { name: '三线', cost: 325 },
  firepea: { name: '火豌豆', cost: 250 },
  cactus: { name: '仙人掌', cost: 125 },
};

export const ZOMBIES = {
  normal: { name: '普通', hp: 10 },
  cone: { name: '路障', hp: 20 },
  bucket: { name: '铁桶', hp: 40 },
  fast: { name: '快跑', hp: 6 },
  strong: { name: '红眼', hp: 60 },
};

// 「最近在打」这句话能说多久。过了就不许再说——跟书的念头同一个规矩。
export const GAME_TTL = 48 * 3600e3;
// 他安静这么久她才会去开游戏（跟读书共用同一个直觉，但各自可调）。
export const GAME_QUIET_MS = 30 * 60e3;
export const RECENT_KEEP = 5;
// 一局最多记几行真实事件（给她的感想做锚点用）。
const EVENT_KEEP = 12;

/**
 * 五关，照着原版的节奏来：先教学、再一点点解锁植物、波次慢慢加上去。
 *
 * 每关的波数是真的交给游戏引擎的（`maxWaves`），不是我们这边"算她赢"：
 * 引擎自己在第 N 波结束后判胜利并加分，所以过关这件事是她真打出来的。
 * 植物没解锁就种不了——这是我们的规矩（复刻版自己不管这个），她得先争到那一关。
 */
export const LEVELS = [
  { n: 1, name: '第一关（教学）', waves: 2, plants: ['sunflower', 'peashooter'],
    tip: '这是第一关，只有两波：先种向日葵攒阳光，再在前排种豌豆。' },
  { n: 2, name: '第二关', waves: 4, plants: ['sunflower', 'peashooter', 'wallnut'],
    tip: '僵尸会啃植物了，坚果挡在前面能多撑几秒。' },
  { n: 3, name: '第三关', waves: 7, plants: ['sunflower', 'peashooter', 'wallnut', 'snowpea'],
    tip: '铁桶僵尸很肉，寒冰能把它拖慢。' },
  { n: 4, name: '第四关', waves: 12, plants: ['sunflower', 'peashooter', 'wallnut', 'snowpea', 'repeater', 'chomper'],
    tip: '双发打得快，大嘴花能吃掉贴脸的僵尸。' },
  { n: 5, name: '第五关', waves: 20, plants: Object.keys(PLANTS),
    tip: '最后二十波，九种植物全给你了。撑过去就通关。' },
];
export const MAX_LEVEL = LEVELS.length;

/** 第几关的配置。越界就夹到 1..5。 */
export function levelInfo(n = 1) {
  const i = Math.min(MAX_LEVEL, Math.max(1, Number(n) || 1)) - 1;
  return LEVELS[i];
}

/** 她现在是第几关：过了几关就解锁下一关；五关都过了就继续刷第五关。 */
export function currentLevel(state = {}) {
  const cleared = Array.isArray(state?.cleared) ? state.cleared.map(Number) : [];
  let n = 1;
  while (cleared.includes(n) && n < MAX_LEVEL) n += 1;
  return n;
}

/** 这一关她有的植物。没解锁的种不了——这条由 host 在落子前拦。 */
export function unlockedPlants(state = {}) {
  return levelInfo(currentLevel(state)).plants;
}

/** 这一手准不准种：没解锁的植物直接不算。 */
export function moveAllowed(state = {}, move = {}) {
  if (!move || move.kind !== 'plant') return true;
  return unlockedPlants(state).includes(move.plant);
}

/** 某一关的最好成绩。每关分开记——拿第五关的成绩去压第一关没有意义。 */
export function bestOf(state = {}, level = 1) {
  const hit = state?.top?.[String(level)];
  return hit && Number(hit.wave) > 0 ? hit : null;
}

/** 花草别名 → key。长的先匹配：不然「火豌豆」会被「豌豆」抢走。 */
const ALIAS = new Map([
  ['向日葵', 'sunflower'], ['太阳花', 'sunflower'], ['葵花', 'sunflower'],
  ['火豌豆', 'firepea'], ['火焰豌豆', 'firepea'],
  ['豌豆射手', 'peashooter'], ['豌豆', 'peashooter'],
  ['双发射手', 'repeater'], ['双发', 'repeater'],
  ['寒冰射手', 'snowpea'], ['寒冰', 'snowpea'], ['冰豌豆', 'snowpea'],
  ['坚果墙', 'wallnut'], ['坚果', 'wallnut'], ['墙果', 'wallnut'],
  ['大嘴花', 'chomper'], ['食人花', 'chomper'],
  ['三线射手', 'threepeater'], ['三线', 'threepeater'],
  ['仙人掌', 'cactus'],
].sort((a, b) => b[0].length - a[0].length));

/** 文本里提到的植物（长名优先）。找不到就空。 */
export function plantIn(text = '') {
  const s = String(text ?? '');
  for (const [alias, key] of ALIAS) if (s.includes(alias)) return key;
  return '';
}

/**
 * 解析她这一回合的指令。
 *
 * 只在行=1..5、列=1..9 的范围内认（给她的图就是这套数，0 基会让她算错）。
 * 认不出来就返回 null——上层当「先等」，绝不替她瞎种。
 */
export function parseMove(reply) {
  const raw = String(reply ?? '');
  if (!raw.trim()) return null;
  // 优先读方括号里的：`[种:豌豆 3,2]`
  const marked = /\[种\s*[:：]\s*([^\]]{1,40})\]/.exec(raw);
  const body = marked ? marked[1] : raw;
  if (/先?等|等等|不用|先不动|稳住|不急|攒阳光|攒着/.test(body)) return { kind: 'wait' };
  const plant = plantIn(body);
  if (!plant) return null;
  const nums = [...body.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n >= 0 && n <= 20);
  if (nums.length < 2) return null;
  // 行、列；写反了（列,行）也认，只要有一个组合落在范围内。
  const tries = [[nums[0], nums[1]], [nums[1], nums[0]]];
  for (const [row, col] of tries) {
    if (row >= 1 && row <= ROWS && col >= 1 && col <= COLS) {
      return { kind: 'plant', plant, row: row - 1, col: col - 1 };
    }
  }
  return null;
}

/**
 * 这一波会来多少、多密——直接照复刻版的 spawnZombieWave 算（不是猜的）：
 *   count = min(3 + floor(wave/2), 15)，间隔 = max(3000 - wave*100, 1000) 毫秒。
 * 每波固定 30 秒，时间到就下一波（不等你清完）。她该知道难度在涨。
 */
export function waveInfo(wave = 1) {
  const w = Math.max(1, Number(wave) || 1);
  return {
    count: Math.min(3 + Math.floor(w / 2), 15),
    gapSec: Math.max(3000 - w * 100, 1000) / 1000,
  };
}

const shortName = (key) => (PLANTS[key]?.name || String(key || '?')).slice(0, 2);

/** 她把草坪看成什么样：5 行 × 9 列，`·` 是空地。 */
export function lawnText(snap = {}) {
  const cells = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => '·'));
  for (const p of snap.plants || []) {
    if (p?.row >= 0 && p.row < ROWS && p?.col >= 0 && p.col < COLS) cells[p.row][p.col] = shortName(p.type);
  }
  const rows = cells.map((r, i) => `${i + 1}| ${r.join(' ')}`);
  const lines = [`${'   '}${Array.from({ length: COLS }, (_, i) => `${i + 1} `).join('')}`.trimEnd(), ...rows];

  const zs = (snap.zombies || [])
    .filter((z) => ZOMBIES[z?.type])
    .sort((a, b) => (a.row - b.row) || (a.col - b.col))
    .slice(0, 8)
    .map((z) => `第${Number(z.row) + 1}行 ${ZOMBIES[z.type].name}@第${Math.max(1, Math.ceil(Number(z.col) || 1))}列 血${Math.round(Number(z.health) || 0)}`);
  const sun = Number(snap.sun) || 0;
  const afford = Object.entries(PLANTS).filter(([, v]) => v.cost <= sun).map(([, v]) => v.name).join('/') || '什么都种不起';
  const wave = Number(snap.wave) || 1;
  const info = waveInfo(wave);
  return [
    lines.join('\n'),
    zs.length ? `僵尸：${zs.join('；')}` : '僵尸：这一眼没有',
    `阳光 ${sun}（买得起：${afford}）；第 ${wave}/${Number(snap.maxWaves) || 20} 波（这一波约 ${info.count} 个，每 ${info.gapSec} 秒一个）；分数 ${Number(snap.score) || 0}；打掉 ${Number(snap.defeated) || 0} 个。`,
  ].join('\n');
}

/** 这局到底发生了什么——给她的感想当锚点，也进 memory 卡。只写真事。 */
export function resultText(snap = {}, minutes = 0, level = null) {
  const wave = Number(snap.wave) || 1;
  const maxWaves = Number(snap.maxWaves) || 20;
  const n = Number(level) || currentLevel({ cleared: [] });
  const bits = [`第 ${n} 关（${maxWaves} 波）`, `打到第 ${wave}/${maxWaves} 波`];
  bits.push(snap.victory ? '把僵尸全挡回去了' : '没挡住');
  bits.push(`分数 ${Number(snap.score) || 0}`);
  bits.push(`打掉 ${Number(snap.defeated) || 0} 个僵尸`);
  if (minutes > 0) bits.push(`玩了 ${Math.max(1, Math.round(minutes))} 分钟`);
  return bits.join('，');
}

/**
 * 她的指令提示：只给规则、价格、战况。不替她想「该怎么打」——
 * 只有第一关给一句教学，因为那是教学关，原版也教。
 */
export function gameTurnPrompt({ state = {}, minutesLeft = 0 } = {}) {
  const lv = levelInfo(currentLevel(state));
  const cost = lv.plants.map((k) => `${PLANTS[k].name}${PLANTS[k].cost}`).join(' ');
  const hp = Object.values(ZOMBIES).map((z) => `${z.name}${z.hp}`).join(' ');
  const best = bestOf(state, lv.n);
  return [
    `你在玩《植物大战僵尸》（一个开源复刻版，不是原版，数值不一样）。这一局是第 ${lv.n} 关，打 ${lv.waves} 波。`,
    `草地 5 行 × 9 列（行从上到下 1-5，列从左到右 1-9）。僵尸从右边来，走到最左边你就输；撑过 ${lv.waves} 波就过关。`,
    '每波固定 30 秒，时间到就下一波，不等你清完；越往后一波更多、来得更密、咬得更重。',
    `这一关你能用的植物：${cost}。向日葵也会射击${lv.plants.includes('wallnut') ? '，坚果很肉' : ''}。僵尸血量：${hp}。`,
    '你这一回合只能做一件事：在某一格种一棵植物，或者先等一等（攒阳光、等冷却）。',
    '只回一行，不要解释：`[种:豌豆 3,2]` 或 `[等]`。',
    lv.tip,
    best ? `这一关你最好打到第 ${best.wave} 波。` : '这一关你还没打过。',
  ].filter(Boolean).join('\n');
}

const RE_MARK = /\[玩\s*[:：]\s*(爽|触动|酸|闷|尬|烦|无感)\s*([1-3])?\s*\]/;
const RE_ANY = /\[玩[^\]]*\]/g;
// 模型在 maxTokens 处被切断时尾巴是「[玩」这种没闭合的残片，剥掉（读书那边踩过）。
const RE_CUT = /\[玩[^\]]*$/;

/**
 * 局后的反应：感想 + 标签 + 强度 + 锚点。
 * 锚点必须来自这局真实战况（她引了里面的字），锚不上就不推情绪——跟读书同一条规矩。
 */
export function parseGameReaction(reply, material = '') {
  const raw = String(reply ?? '');
  const hit = RE_MARK.exec(raw);
  const thought = raw.replace(RE_ANY, '').replace(RE_CUT, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const anchor = anchorOf(thought, material);
  return {
    thought,
    label: hit ? hit[1] : '无感',
    intensity: hit && hit[2] ? Number(hit[2]) : 0,
    anchor,
    anchored: Boolean(anchor),
  };
}

/** 跟读书共用一个情绪词表：她只有一套情绪，不该因为活动不同写两套。 */
export function gameEmotion(reaction) {
  return reactionEmotion(reaction);
}

/**
 * 记一局。每关最好成绩分开记（`top`），过关就写进 `cleared`，下一关自动解锁。
 * 没锚点的反应只存感想，标签清零——账不能记在演出来的情绪上。
 */
export function noteGame(state = {}, { now = 0, day = '', snap = {}, minutes = 0, reaction = null, level = null } = {}) {
  const n = Number(level) || currentLevel(state);
  const wave = Number(snap.wave) || 1;
  const maxWaves = Number(snap.maxWaves) || levelInfo(n).waves;
  const victory = Boolean(snap.victory);
  const over = Boolean(snap.over);
  const score = Number(snap.score) || 0;
  const defeated = Number(snap.defeated) || 0;
  const trusted = reaction?.anchored ? reaction : { thought: String(reaction?.thought || ''), label: '', intensity: 0, anchor: '' };
  const entry = {
    at: now, day, level: n, wave, maxWaves, victory, over, score, defeated,
    minutes: Math.max(0, Math.round(Number(minutes) || 0)),
    thought: trusted.thought, label: trusted.label, intensity: trusted.intensity, anchor: trusted.anchor,
  };
  const prevBest = bestOf(state, n) || { wave: 0, victory: false, score: 0, at: 0 };
  const better = wave > Number(prevBest.wave)
    || (wave === Number(prevBest.wave) && victory && !prevBest.victory)
    || (victory && !prevBest.victory);
  const top = { ...(state.top || {}) };
  if (better) top[String(n)] = { wave, victory, score, at: now };
  const cleared = Array.from(new Set([
    ...(Array.isArray(state.cleared) ? state.cleared.map(Number) : []),
    ...(victory ? [n] : []),
  ])).sort((a, b) => a - b);
  return {
    ...state,
    at: now,
    day,
    plays: (Number(state.plays) || 0) + 1,
    level: currentLevel({ cleared }),
    cleared,
    top,
    last: entry,
    recent: [entry, ...(state.recent || [])].slice(0, RECENT_KEEP),
    events: (state.events || []).slice(-EVENT_KEEP),
  };
}

/** 这一局新发生的真事（用来做锚点和记日志）。 */
export function gameEvents(prev = {}, snap = {}) {
  const list = [];
  if (!prev.last) list.push(`开局，第 ${Number(snap.wave) || 1} 波`);
  if (snap.victory) list.push('把 20 波全挡回去了');
  else if (snap.over) list.push(`第 ${Number(snap.wave) || 1} 波被突破，输了`);
  return list;
}

/**
 * 她能说出口的那一行。过了 GAME_TTL 就什么都不返回——
 * 「最近在打」过期了还说，就是编。
 */
export function gameLine(state = {}, now = 0) {
  const last = state?.last;
  const at = Number(last?.at) || 0;
  if (!at || !last?.wave) return { text: '', at: 0, ttl: 0 };
  if (now - at > GAME_TTL) return { text: '', at, ttl: GAME_TTL };
  const lv = Number(last.level) || currentLevel(state);
  const cleared = Array.isArray(state.cleared) ? state.cleared.map(Number) : [];
  const maxWaves = Number(last.maxWaves) || levelInfo(lv).waves;
  let text = `你最近在打《植物大战僵尸》第 ${lv} 关（${maxWaves} 波）：上一局打到第 ${last.wave}/${maxWaves} 波，`
    + (last.victory ? '过了' : '没撑住');
  if (Number(last.score) > 0) text += `，分数 ${last.score}`;
  if (last.thought) text += `（你的原话：${last.thought}）`;
  if (cleared.length) text += `；已经过了第 ${cleared.join('、')} 关`;
  if (cleared.length >= MAX_LEVEL) text += '（五关都过了）';
  return { text: `${text}。`, at, ttl: GAME_TTL };
}

/**
 * 现在该不该自己开一局。
 * 判据全是真事：他安静多久、上次玩到什么时候、今天玩过几局、心情。
 */
export function shouldPlay({
  now = 0, lastUserAt = 0, lastPlayAt = 0, playsToday = 0, mood = 0.5,
  quietMs = GAME_QUIET_MS, maxPerDay = 1,
} = {}) {
  if (!lastUserAt) return false;
  if (Number(playsToday) >= Number(maxPerDay)) return false;
  if (Number(mood) < 0.3) return false;
  if (lastPlayAt && now - Number(lastPlayAt) < quietMs) return false;
  return now - Number(lastUserAt) >= quietMs;
}
