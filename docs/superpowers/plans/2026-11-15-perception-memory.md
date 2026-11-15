# 感知记忆（perception memory）实施计划

> **给执行者：** 建议用 subagent-driven-development（每个任务一个新 subagent + 复核）或 executing-plans（本会话内自己做）。步骤用 `- [ ]` 勾选。

**目标：** 让她把看过的图**存在本机**，并且能用一句人话把它找回来——先文字召回候选，再让视觉模型真看图确认是哪一张。

**架构：** 三个纯函数模块（`src/perception/slots.js` 解析模型输出、`store.js` 管索引与清理、`recall.js` 管召回与复核），由 `host.js` 负责文件、模型调用和注入。图落 `perception/YYYY-MM/`，索引单文件 `perception.json`，复用现有的 `createJsonStore`、`search()`、`shrinkImage()`、`describeImage()`、`blk()`。

**技术栈：** Node ≥22.13、sharp（已在依赖里，**不新增依赖**）、DeepSeek `chat/completions`（视觉走现有 `describeImage`）。

**设计文档：** `docs/superpowers/specs/2026-11-15-perception-memory-design.md`（执行时两篇一起读）

## 全局约束

- 不新增任何 npm 依赖。缩略图用现成的 `shrinkImage(bytes, {max, quality})`。
- 所有测试不联网、不碰真实 `dataDir`（用 `mkdtempSync`）。测试命令：
  `D:\SnowLuma\node.exe --test --test-isolation=none --test-force-exit "test/perception-*.test.mjs"`
  全套：`... "test/*.test.mjs"`（当前 478 条全过，改动后不能少）。
- 图只落本机磁盘；`perception.json` 里只存相对路径，**不存 base64**。
- 感知记忆**不进**记忆卡的 2200 字预算：注入走独立 `blk()`，ttl 5 分钟。
- 出到模型的东西只有两次调用：写入时的描述调用、检索时的复核调用。复核 ≤5 次/小时。
- 时间一律用注入的 `now()`，不要在纯函数里读 `Date.now()`。

## Review Focus

1. **视觉模型没按格式回 JSON**（它经常带一句解释或围栏）→ 图仍要存下来，正文不能变成一段 JSON。
2. **同一张图重复发**（同 sha）→ 不重复占盘，只 `hits++`。
3. **他提到"那张图"但库里没有对应的图** → 不报错、不注入、不硬凑。
4. **目录不可写 / 磁盘满** → 这一轮照常回话，只是没存下这张图。
5. **新旧记录混存**（迁移来的记录没有 `sha`/`title`）→ 读和召回都不能炸。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/perception/slots.js`（新建） | 模型输出 → `{title, desc, slots}`；`slotsText()` 拼检索文本 |
| `src/perception/store.js`（新建） | 索引纯函数：`sha12`、去重、条数上限、容量清理、冷清理、统计 |
| `src/perception/recall.js`（新建） | 触发判断、文字召回 + 门槛、复核提示词与解析、限流、注入行 |
| `src/host.js`（改） | 写：`withImages` 暂存 + `memoryBlock` 落盘；读：`contextBlock` 注入；面板计数；心跳清理 |
| `src/panel.js`（改） | 运行区显示 `图 N 张（原图 M 张，占 X MB）` |
| `test/perception-slots.test.mjs`（新建） | 任务 1 |
| `test/perception-store.test.mjs`（新建） | 任务 2 |
| `test/perception-recall.test.mjs`（新建） | 任务 3 |
| `test/host.test.mjs`（改） | 任务 4、5、6 的接线测试 |
| `scripts/migrate-perception.mjs`（新建） | 任务 7，默认 dry-run |

**数据形状**（任务 2 定义，后续任务都按这个来）：

```js
// 索引
{ version: 1, records: [Rec], stats: { added: 0, deduped: 0, pruned: 0, cold: 0 } }
// Rec
{ id: 'p_3f9a1c77', sha: '3f9a1c77a1b2', at, source: 'his', scene: 'chat',
  file, thumb, pixels: true, w, h, bytes, mime, frames,
  title, desc, slots: { who: [], what: [], where: [], action: [], look: [] },
  feel, heat, memoryId, hits: 0, lastHitAt: 0, vec: null }
```

---

### Task 1: 解析模型输出

**Files:**
- Create: `src/perception/slots.js`
- Test: `test/perception-slots.test.mjs`

**Interfaces:**
- Produces: `parsePerception(text) -> {title, desc, slots}`、`slotsText(rec) -> string`、`SLOT_KINDS = ['who','what','where','action','look']`

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePerception, slotsText, SLOT_KINDS } from '../src/perception/slots.js';

test('正常的 JSON：三个字段都拿到', () => {
  const r = parsePerception('{"title":"粉发女孩","desc":"一个粉色头发的女孩举着牌子","slots":{"who":["女孩"],"look":["粉发"]}}');
  assert.equal(r.title, '粉发女孩');
  assert.equal(r.desc, '一个粉色头发的女孩举着牌子');
  assert.deepEqual(r.slots.who, ['女孩']);
  assert.deepEqual(r.slots.what, [], '没给的槽是空数组，不是 undefined');
});

test('带代码围栏也能解析', () => {
  const r = parsePerception('```json\n{"title":"猫","desc":"一只猫"}\n```');
  assert.equal(r.title, '猫');
  assert.equal(r.desc, '一只猫');
});

test('完全不按格式：整段当 desc，标题截前 30 字，槽留空（图不能丢）', () => {
  const prose = '画面中有一个戴帽子的金发像素女孩在点头，动作循环。';
  const r = parsePerception(prose);
  assert.equal(r.desc, prose);
  assert.equal(r.title, prose.slice(0, 30));
  assert.deepEqual(r.slots.who, []);
});

test('JSON 里没 desc：用 title 顶上，正文不能为空', () => {
  const r = parsePerception('{"title":"猫"}');
  assert.equal(r.desc, '猫');
});

test('槽值不是数组：忽略，不炸', () => {
  const r = parsePerception('{"title":"t","desc":"d","slots":{"who":"女孩"}}');
  assert.deepEqual(r.slots.who, []);
});

test('slotsText 把标题、描述和所有槽拼成可检索文本', () => {
  const text = slotsText({ title: '粉发女孩', desc: '举着牌子', slots: { who: ['女孩'], look: ['粉发'] } });
  for (const part of ['粉发女孩', '举着牌子', '女孩']) assert.ok(text.includes(part), part);
});

test('SLOT_KINDS 是那五类', () => {
  assert.deepEqual(SLOT_KINDS, ['who', 'what', 'where', 'action', 'look']);
});
```

- [ ] **Step 2: 跑测试，确认全红**

Run: `D:\SnowLuma\node.exe --test --test-isolation=none --test-force-exit "test/perception-slots.test.mjs"`
Expected: FAIL，`Cannot find module '../src/perception/slots.js'`

- [ ] **Step 3: 实现 `src/perception/slots.js`**

要点：先试 `JSON.parse`，失败就剥围栏和前后杂字（取第一个 `{` 到最后一个 `}`）再试；还不行就走散文兜底。槽只认 `SLOT_KINDS`，值必须是字符串数组，每类最多 4 个、每个最多 12 字。`title` ≤30 字，`desc` ≤400 字。

- [ ] **Step 4: 跑测试，确认全绿**

Run: 同 Step 2。Expected: PASS（7 条）。

- [ ] **Step 5: 提交**

```bash
git add src/perception/slots.js test/perception-slots.test.mjs
git commit -m "feat(perception): 解析视觉模型的三字段输出，解析失败退回散文"
```

---

### Task 2: 索引与清理（纯函数）

**Files:**
- Create: `src/perception/store.js`
- Test: `test/perception-store.test.mjs`

**Interfaces:**
- Produces:
  - `sha12(bytes) -> string`（sha256 前 12 位 hex）
  - `createIndex() -> Index`
  - `addRecord(index, rec, {maxRecords = 4000}) -> Index`（同 sha 已存在则只 `hits++`/`lastHitAt`/`at`，不新增；超上限淘汰 `lastHitAt || at` 最老的）
  - `prunePixels(index, {maxBytes = 2 * 1024 ** 3}) -> {index, removed: string[]}`（删原图文件路径列表，记录标 `pixels:false`）
  - `pruneCold(index, {now, days = 90, heat = 0.35}) -> {index, removed: string[]}`（`hits===0` 且 `at` 早于 `now - days` 且 `heat < heat` → 整条删）
  - `statsOf(index) -> {total, pixels, bytes}`

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { addRecord, createIndex, pruneCold, prunePixels, sha12, statsOf } from '../src/perception/store.js';

const DAY = 86400e3;
const rec = (over = {}) => ({
  id: 'p_1', sha: 'a', at: 0, file: 'f1.jpg', thumb: 'f1.thumb.jpg', pixels: true,
  bytes: 100, title: 't', desc: 'd', slots: {}, hits: 0, lastHitAt: 0, heat: 0.1, ...over,
});

test('sha12 是 sha256 前 12 位，同样的字节一样', () => {
  const b = Buffer.from('hello');
  assert.equal(sha12(b).length, 12);
  assert.equal(sha12(b), sha12(Buffer.from('hello')));
});

test('同 sha 第二次：不新增，只加 hits 和 lastHitAt', () => {
  let idx = addRecord(createIndex(), rec());
  idx = addRecord(idx, rec({ at: 5000 }));
  assert.equal(idx.records.length, 1);
  assert.equal(idx.records[0].hits, 1);
  assert.equal(idx.records[0].lastHitAt, 5000);
  assert.equal(idx.stats.deduped, 1);
});

test('超过条数上限：淘汰最久没被找回过的那条', () => {
  let idx = createIndex();
  idx = addRecord(idx, rec({ id: 'p_1', sha: 'a', lastHitAt: 9000 }));
  idx = addRecord(idx, rec({ id: 'p_2', sha: 'b', lastHitAt: 0, at: 1 }), { maxRecords: 2 });
  idx = addRecord(idx, rec({ id: 'p_3', sha: 'c', lastHitAt: 8000 }), { maxRecords: 2 });
  assert.equal(idx.records.length, 2);
  assert.equal(idx.records.some((r) => r.id === 'p_2'), false, '被找回过的不该先淘汰');
});

test('容量超限：删最老的原图，记录留着、pixels 变 false', () => {
  let idx = createIndex();
  idx = addRecord(idx, rec({ id: 'p_old', sha: 'a', bytes: 100, at: 1 }));
  idx = addRecord(idx, rec({ id: 'p_new', sha: 'b', bytes: 100, at: 2 }));
  const out = prunePixels(idx, { maxBytes: 150 });
  assert.deepEqual(out.removed, ['f1.jpg']);
  assert.equal(out.index.records.length, 2, '记录不删');
  assert.equal(out.index.records[0].pixels, false);
  assert.equal(out.index.records[1].pixels, true);
});

test('冷清理：只删「没被找回 + 够老 + 当时不重」的', () => {
  const now = 200 * DAY;
  let idx = createIndex();
  idx = addRecord(idx, rec({ id: 'p_cold', sha: 'a', at: 0, heat: 0.1 }));
  idx = addRecord(idx, rec({ id: 'p_hot', sha: 'b', at: 0, heat: 0.8 }));
  idx = addRecord(idx, rec({ id: 'p_hit', sha: 'c', at: 0, heat: 0.1, hits: 2 }));
  idx = addRecord(idx, rec({ id: 'p_fresh', sha: 'd', at: now - DAY, heat: 0.1 }));
  const out = pruneCold(idx, { now });
  assert.deepEqual(out.removed, ['f1.jpg']);
  assert.equal(out.index.records.length, 3);
});

test('statsOf 数得对', () => {
  let idx = addRecord(createIndex(), rec({ id: 'p_1', sha: 'a', bytes: 100 }));
  idx = addRecord(idx, rec({ id: 'p_2', sha: 'b', bytes: 100, pixels: false }));
  assert.deepEqual(statsOf(idx), { total: 2, pixels: 1, bytes: 200 });
});
```

- [ ] **Step 2: 跑测试，确认全红**

Run: `D:\SnowLuma\node.exe --test --test-isolation=none --test-force-exit "test/perception-store.test.mjs"`
Expected: FAIL，`Cannot find module`

- [ ] **Step 3: 实现 `src/perception/store.js`**

纯函数，不碰 fs（删除文件由 host 做——它拿到 `removed` 路径列表去 `unlinkSync`）。全部返回新对象，不改入参。

- [ ] **Step 4: 跑测试，确认全绿**

Expected: PASS（6 条）。

- [ ] **Step 5: 提交**

```bash
git add src/perception/store.js test/perception-store.test.mjs
git commit -m "feat(perception): 索引纯函数——去重、条数上限、容量与冷清理"
```

---

### Task 3: 召回与复核

**Files:**
- Create: `src/perception/recall.js`
- Test: `test/perception-recall.test.mjs`

**Interfaces:**
- Produces:
  - `RECALL_TRIGGER = /那张|这张|图|照片|截图|上次发的|刚才发的|看到的|图里|画面/`
  - `shouldRecall(text) -> boolean`
  - `candidates(records, query, {now, limit = 5, minScore = 0.35}) -> Rec[]`（用 `memory/search.js` 的 `search()`，记录先补 `text = slotsText(rec)`；`top1.score < minScore` 返回 `[]`）
  - `RECHECK_PROMPT`（字符串）、`parsePick(text, n) -> number`（1..n 或 0）
  - `RECHECK_MAX_PER_HOUR = 5`、`canRecheck(state, now) -> boolean`、`noteRecheck(state, now) -> state`（state 形如 `{at: number[]}`）
  - `perceptionLine(rec, now) -> string`（≤60 字，`- 11-14 21:03 他发的：<title>`）

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECHECK_MAX_PER_HOUR, canRecheck, candidates, noteRecheck, parsePick, perceptionLine, shouldRecall,
} from '../src/perception/recall.js';

const HOUR = 3600e3;
const r = (over) => ({ id: 'p', title: 't', desc: 'd', slots: {}, at: 0, lastSeenAt: 0, hits: 0, ...over });

test('只有出现指代词才去召回', () => {
  assert.equal(shouldRecall('你看那张图'), true);
  assert.equal(shouldRecall('上次发的那个'), true);
  assert.equal(shouldRecall('今天吃了面条'), false);
});

test('召回：找得到那条相关的', () => {
  const records = [
    r({ id: 'p_food', title: '一碗面条', desc: '热气腾腾的面' }),
    r({ id: 'p_girl', title: '粉发女孩', desc: '粉色头发的女孩举着牌子', slots: { look: ['粉发'] } }),
  ];
  const got = candidates(records, '粉头发的那个图', { now: 0 });
  assert.equal(got[0].id, 'p_girl');
});

test('门槛：完全不相关就返回空，不硬凑', () => {
  const records = [r({ id: 'p_food', title: '一碗面条', desc: '热气腾腾的面' })];
  assert.deepEqual(candidates(records, '量子力学图灵机', { now: 0 }), []);
});

test('parsing 复核结果：数字、JSON、都不是', () => {
  assert.equal(parsePick('2', 3), 2);
  assert.equal(parsePick('{"pick":3}', 3), 3);
  assert.equal(parsePick('都不是', 3), 0);
  assert.equal(parsePick('{"pick":9}', 3), 0, '越界当没选中');
  assert.equal(parsePick('', 3), 0);
});

test('限流：一小时最多 5 次', () => {
  let state = {};
  for (let i = 0; i < RECHECK_MAX_PER_HOUR; i++) {
    assert.equal(canRecheck(state, i), true);
    state = noteRecheck(state, i);
  }
  assert.equal(canRecheck(state, 100), false);
  assert.equal(canRecheck(state, HOUR + 1), true, '一小时后就放过');
});

test('注入行：带时间、来源、标题', () => {
  const line = perceptionLine(r({ title: '粉发女孩' }), new Date(2026, 10, 14, 21, 3).getTime());
  assert.match(line, /11-14 21:03/);
  assert.match(line, /他发的/);
  assert.match(line, /粉发女孩/);
});

test('老记录缺字段（迁移来的、没有 title/slots）也不炸', () => {
  const legacy = [{ id: 'p_old', desc: '一张很老的图', at: 0 }];
  assert.doesNotThrow(() => candidates(legacy, '那张老图', { now: 0 }));
  assert.match(perceptionLine({ id: 'p_old', at: 0 }, 0), /一张没起名的图|他发的/);
});
```

- [ ] **Step 2: 跑测试，确认全红**

- [ ] **Step 3: 实现 `src/perception/recall.js`**

`candidates` 内部：`search(records.map((x) => ({ ...x, text: slotsText(x) })), query, { now, limit })`，再把 `rec` 还原；门槛比较 `结果[0].score`。`RECHECK_PROMPT` 用设计文档 §六 的那句中文。`perceptionLine` 用 `MM-DD HH:MM` 本地时间。

- [ ] **Step 4: 跑测试，确认全绿**

Expected: PASS（6 条）。

- [ ] **Step 5: 提交**

```bash
git add src/perception/recall.js test/perception-recall.test.mjs
git commit -m "feat(perception): 触发词、文字召回门槛、复核解析与限流"
```

---

### Task 4: 接进 host——图到达时存下来

**Files:**
- Modify: `src/host.js`（`withImages` 约 901-970；`memoryBlock` 约 250-284；顶部 import 与 store 初始化）
- Test: `test/host.test.mjs`（追加）

**Interfaces:**
- Consumes: 任务 1 的 `parsePerception`、任务 2 的 `sha12/createIndex/addRecord`、现有 `describeImage/shrinkImage/createJsonStore`
- Produces（本任务内部）：`pendingPerceptions` 数组、`drainPerceptions({mood, heat, memoryId}) -> number`、`perceptionStore`（`createJsonStore(join(dataDir,'perception.json'))`）、`PERCEPTION_PROMPT`

- [ ] **Step 1: 写失败的测试**

```js
test('发图之后：图落盘、索引里有记录、正文仍是「他发了一张图」', async () => {
  // 用 ownerQQ=42 的 host + fetchImpl 同时应答 OneBot 与视觉接口
  // 视觉接口回 {"title":"粉发女孩","desc":"粉色头发的女孩举着牌子","slots":{"look":["粉发"]}}
  const r = await host.handleEvent({ post_type:'message', message_type:'private', user_id:42,
    message: [{ type:'text', data:{ text:'看这个' } }, { type:'image', data:{ url:'https://p.qpic.cn/x/1' } }],
    time: Math.floor(NOON/1000) });

  const idx = JSON.parse(readFileSync(join(dataDir,'perception.json'),'utf8'));
  assert.equal(idx.records.length, 1);
  assert.equal(idx.records[0].title, '粉发女孩');
  assert.equal(idx.records[0].pixels, true);
  assert.ok(existsSync(join(dataDir, idx.records[0].file)), '原图要真写下来');
  assert.ok(existsSync(join(dataDir, idx.records[0].thumb)), '缩略图也要');
  assert.doesNotMatch(readFileSync(join(dataDir,'perception.json'),'utf8'), /base64/, '索引里只存路径');
  assert.ok(idx.records[0].heat > 0, '那一刻的重量要填上（靠队列交接）');
  const rec = host.memory.card().records.at(-1);
  assert.match(rec.text, /他发了一张图/);
  assert.doesNotMatch(rec.text, /粉色头发的女孩/, '画面不进记忆卡正文');
  assert.equal(idx.records[0].memoryId, rec.id, '能连上就连上');
});

test('视觉模型没按格式回：图照样存，正文不是一段 JSON', async () => {
  // fetchImpl 的视觉接口回 '就是一张图而已'（散文）
  // 断言：索引里有 1 条、title 是散文前 30 字、记录存在；
  // 并且这一轮的正文（从 memory 卡看）不含 '{' 也不含 'slots'
});

test('图写不下来：这一轮照常回话，不抛错', async () => {
  // 先建一个名为 perception 的**文件**（不是目录），让 mkdirSync 必然失败
  // 断言：handleEvent 正常返回、发出去了回复、perception.json 里 0 条
});
```

- [ ] **Step 2: 跑测试，确认失败**（`perception.json` 不存在）

- [ ] **Step 3: 改 `src/host.js`**

1. 顶部 import：`parsePerception`、`createIndex/addRecord/sha12`、`PERCEPTION_PROMPT`（本文件里定义）。
2. 在 `withImages` 里：把现有 `describeImage(...)` 的 `prompt` 换成 `PERCEPTION_PROMPT`（JSON 三字段）；把返回文本过 `parsePerception`；`seen.push({ ok:true, text: parsed.desc })`（**正文用 `desc`，不是 JSON**）；同时把 `{bytes, mime, w, h, frames, ...parsed, at: now()}` 推进 `pendingPerceptions`。动图分支同样处理（用 `desc` 当 `text`）。
3. 新增 `async function drainPerceptions({ mood, heat, memoryId } = {})`：取空队列，丢弃 `now - at > 120e3` 的；每条算 `sha12`、`mkdirSync(dirname, {recursive:true})`、写原图和缩略图（`shrinkImage(bytes,{max:320,quality:60})`，失败就不写缩略图、`thumb:''`）、`addRecord`；最后 `perceptionStore.save`。**任何一步抛错都 `log.warn` 后跳过这一张，不影响回话。**
4. `memoryBlock` 末尾（`memoryStore.save(card)` 之后）调用 `await drainPerceptions({ mood, heat: h, memoryId: card.records.at(-1)?.id ?? null })`。

- [ ] **Step 4: 跑测试，确认全绿**

Run: `D:\SnowLuma\node.exe --test --test-isolation=none --test-force-exit "test/host.test.mjs"`

- [ ] **Step 5: 跑全套，确认没退化**

Run: 全套 `test/*.test.mjs`。Expected: 现有 478 条 + 新增 2 条全过。

- [ ] **Step 6: 提交**

```bash
git add src/host.js test/host.test.mjs
git commit -m "feat(perception): 图到达时落盘并写索引，画面不进记忆卡正文"
```

---

### Task 5: 接进 host——想起来时找出来并注入

**Files:**
- Modify: `src/host.js`（`contextBlock` 约 575-591；新增 `recallPerception`）
- Test: `test/host.test.mjs`（追加）

**Interfaces:**
- Consumes: 任务 3 的 `shouldRecall/candidates/parsePick/canRecheck/noteRecheck/perceptionLine/RECHECK_PROMPT`
- Produces: `recallPerception(text, t) -> { line: string, at: number }`（没命中返回 `{ line:'', at:t }`）

- [ ] **Step 1: 写失败的测试**

```js
test('他说「那张图」：注入一条「你看到过的」，并且真的看过缩略图', async () => {
  // 预置 perception.json 两条记录 + 两个真实小文件（写 1x1 jpeg 字节即可）
  // 视觉接口第一次回描述、第二次（复核）回 {"pick":1}
  // 断言：system 里有 '【你看到过的】' 与标题；索引里那条 hits 变 1
});

test('指代命中但库里没有：不注入、不报错', async () => {
  // perception.json 为空
  // 断言：system 不含 '【你看到过的】'；这一轮照常回话
});

test('这一块不进记忆卡预算：记忆卡仍是独立的 2200 字', async () => {
  // 造 30 条记忆卡记录（塞满预算）+ 一条感知记录
  // 断言：system 里【你记得的事】和【你看到过的】同时存在，
  // 且【你记得的事】的行数与没有感知记录时一模一样
});
```

- [ ] **Step 2: 跑测试，确认失败**

- [ ] **Step 3: 改 `src/host.js`**

1. 新增 `recallPerception(text, t)`：`shouldRecall` 不过 → `{ line:'', at:t }`；`candidates(...)` 空 → 同；`canRecheck` 且前 4 条都有可用缩略图 → 发一次 `describeImage({ dataUrls, prompt: RECHECK_PROMPT, ... })`（缩略图读成 data URL），`parsePick` 得 `k`；`k > 0` 用第 k 条，否则用第 1 条；命中后 `hits++`/`lastHitAt` 存盘。返回 `{ line: perceptionLine(hit, t), at: hit.at }`。
2. `contextBlock` 里加一块：`blk('perception', p.line, Number(p.at) || t, 5 * MINUTE)`——`blk` 的 `at` 必须给（`fresh.js` 会校验），没命中时 `line` 是空串、`at` 用 `t`。

- [ ] **Step 4: 跑测试，确认全绿**（两条新用例）

- [ ] **Step 5: 提交**

```bash
git add src/host.js test/host.test.mjs
git commit -m "feat(perception): 指代时召回图片记忆，模型复核后注入一行"
```

---

### Task 6: 面板计数 + 心跳清理

**Files:**
- Modify: `src/host.js`（`heartbeat` 约 1316-1330；`snapshot()` 约 1390；面板调用处约 1500）、`src/panel.js`（运行区那一段）
- Test: `test/host.test.mjs` 与 `test/panel.test.mjs`（追加）

**Interfaces:**
- Consumes: 任务 2 的 `prunePixels/pruneCold/statsOf`
- Produces: `snapshot().perception = { total, pixels, bytes }`

- [ ] **Step 1: 写失败的测试**

```js
test('面板显示图片记忆的数量和占用', async () => {
  // 预置 perception.json 两条（一条 pixels:false）
  // 断言 html 含 '图 2 张' 与 '原图 1 张'
});

test('心跳会清理：冷记录被删、文件也删了', async () => {
  // 预置一条 100 天前、heat 0.1、hits 0 的记录 + 两个真实文件
  // await host.tick()
  // 断言：索引里没有它了，两个文件都不存在了
});
```

- [ ] **Step 2: 跑测试，确认失败**

- [ ] **Step 3: 改代码**

1. `heartbeat()` 里 `enqueue(refreshPerception).catch(...)`：读索引 → `pruneCold` → `prunePixels` → 对返回的 `removed` 路径逐个 `unlinkSync`（`try/catch` 吞掉不存在）→ 保存。
2. `snapshot()` 里加 `perception: statsOf(perceptionStore.load())`；面板调用处传下去；`panel.js` 运行区加一句 `图 N 张（原图 M 张，占 X MB）`。

- [ ] **Step 4: 跑测试，确认全绿**

- [ ] **Step 5: 提交**

```bash
git add src/host.js src/panel.js test/host.test.mjs test/panel.test.mjs
git commit -m "feat(perception): 面板显示占用，心跳清理冷记录和超限原图"
```

---

### Task 7: 老数据迁移（**要用户点头才跑**）

**Files:**
- Create: `scripts/migrate-perception.mjs`
- Test: 手动 dry-run（不写测试文件，脚本默认不写盘）

**Interfaces:**
- Consumes: `parsePerception`（不用，走散文兜底）、`addRecord`、`sha12`

- [ ] **Step 1: 写脚本 `scripts/migrate-perception.mjs`**

默认 **dry-run**：只打印"会迁移 N 条"，列出前 5 条的首 40 字。加 `--write` 才改 `memory.json` 和写 `perception.json`（写前各存一份 `.bak-migrate`）。规则：正文含 `（你看了一眼他刚发来的图：` 的记录 → 抽出括号里的描述 → 建 `pixels:false, scene:'chat', source:'his'` 的感知记录（`desc` = 描述，`title` = 前 30 字，`slots` 空，`sha` = `sha12(描述)`）→ 记忆卡正文换成 `他发了一张图` + 括号后的原文。

- [ ] **Step 2: 跑 dry-run，把输出给用户看**

Run: `D:\SnowLuma\node.exe scripts/migrate-perception.mjs`
Expected: 打印约 26 条候选（17 整段 + 9 另一种旧格式，占位那 4 条跳过）。

- [ ] **Step 3: 等用户同意后才跑 `--write`，跑完核对条数与正文**

- [ ] **Step 4: 提交脚本（不含数据）**

```bash
git add scripts/migrate-perception.mjs
git commit -m "chore(perception): 老记忆迁移脚本，默认 dry-run"
```

---

## 执行顺序与验收

1 → 2 → 3（纯函数，互不依赖，可并行）→ 4 → 5 → 6 →（等同意）7。

**整体验收**：发一张图 → `perception.json` 多一条、原图在盘上 → 过一会儿说「那张图」→ 她上下文里出现 `【你看到过的】` 且能说出画面 → 面板显示张数。全过程记忆卡的 2200 字预算没被吃掉。
