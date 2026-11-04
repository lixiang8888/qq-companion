# 下一阶段 Implementation Plan（连发合并 / 颜文字 / 记忆修正 / 评测 / 自述）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让她的回复节奏像真人（连发合并）、不再切断颜文字、旧事实不会和新事实一起被注入，并第一次给记忆质量一个能看的数字。

**Architecture:** 四个纯函数模块（`mailbox.js` / `message.js` 的切分 / `memory/card.js` 的覆盖 / `insights.js`）+ 三个 host 接线点，全部接受注入的时钟与调度器，离线可测，不新增依赖。

**Tech Stack:** Node 24 ESM、`node:test`、零运行时依赖。

**Spec:** `docs/architecture.md`（现有设计）+ 本文件「整合」一节（外部项目的取舍）

## Global Constraints

- 不新增运行时依赖。
- 所有新模块接受 `now` / `later` / `clear` 注入；测试不依赖真实时间。
- 缺数据时不注入、不写占位句；不编造未发生的事。
- 「一天」按本地日界，不用 `toISOString`。
- 每个任务自己带测试，`npm test` 结束时全绿（当前基线 255 项）。
- 面板上的文本一律 `escapeHtml`。

## Review Focus

- **连发合并不许丢消息、不许乱序**：三条 1 秒内进来，必须三条都进这一轮，顺序与到达一致（Task 1）。
- **合并后的长度上限方向**：三条长消息合起来超过 4000 字时，保留**最近**的部分（他刚说的是要回答的），并把截断说清楚（Task 1）。
- **括号永远不闭合时不能卡死**：颜文字保护要有一个兜底，绝不因为括号没闭合就不切分或无限循环（Task 2）。
- **错误的记忆覆盖比两条矛盾记忆更糟**：覆盖必须是可撤销、面板可见、且只在「新句里有变化词 + 与旧记录共享一个 ≥2 字的名词」时发生（Task 3）。
- **评测集不能自己出题自己答**：题目与期望值写在测试文件里，先跑出基线数字再改算法；分数下降要能看出来（Task 4）。

---

## 整合：外部项目里哪些东西值得拿

调研来源：`dsh-self`（情绪×自我）、`dsh-neuron-memory`（本地记忆抽屉）、`derkinL/dsh-remembers`（分层记忆）、`suis077/dsh-companion`（人设卡+白饭账）、Generative Agents 记忆流。

| 来源 | 做法 | 决定 | 落在哪 |
|---|---|---|---|
| dsh-self / neuron | 连发消息在安静窗口内合并成一轮 | **采纳**，窗口 5 秒（比它的 30 秒短得多） | Task 1 |
| dsh-self / derkinL | 按括号深度切分，颜文字不被拦腰切断 | **采纳**（我们现在有真 bug） | Task 2 |
| neuron | `supersedes`：新事实显式覆盖旧事实，旧的沉底不删 | **采纳**（改成规则版 + 可撤销） | Task 3 |
| neuron | 检索评测：三条腿、噪音率、诱捕题 | **采纳**（我们一个数字都没有） | Task 4 |
| dsh-self / derkinL | 自传体叙事：三类固定认识，各有界 | **采纳**（每周一次，三类 × 最多 20 条） | Task 5 |
| neuron | 复习只回血一半 | **不采纳**：我们的日衰减已经把它拉回来，改了是白改 | — |
| neuron | 同日上下文（想起一件事顺手带出当天前后两条） | **押后**：会和 2200 字预算打架，先看评测再决定 | — |
| dsh-self | 模拟人生「懒推进」（离线也把生活补算出来） | **不采纳**：那等于编造她不在时的经历。我们的原则是「那段时间没有她」 | — |
| dsh-self | 诚实边界靠强制改写（受苦/思念类声明被改写） | **不采纳**：我们用「给她真实材料」代替「审查她的话」 | — |
| dsh-self | 元情绪（对情绪的情绪） | **不采纳**：四层已经够，再加一层是复杂度不是深度 | — |
| dsh-self | explain_log 决策链 | **押后**：真出问题时再补，现在有 `lastError` + 面板够用 | — |
| neuron | 图记忆（激活扩散） | **不采纳**：它自己实测 1 跳噪音 33%→64%、增量 0 | — |
| dsh-self | 睡眠时段不回消息 | **押后**：产品决定，不是技术决定 | — |
| derkinL | 独立 Python 服务 + SQLite + 向量库 | **不采纳**：两个进程、多一套安装守护；我们 3000 条内 BM25 毫秒级 | — |
| suis077 | 好感度 0–100 + 免责声明 | **不采纳**：它自己承认那是装置；我们的 trust/intimacy 是连续量 | — |
| suis077 | 记忆只存 60 字摘要、超限把最旧的折成一条 | **押后**：和我们的「软删除 + 90 天」是两种做法，先看评测 | — |

---

### Task 1: 连发合并（5 秒安静窗口）

**Files:**
- Create: `src/mailbox.js`
- Modify: `src/host.js`（`handleEvent` 之前加一层缓冲；`createHost` 新增 `later` / `clear` / `mergeWindowMs` 注入）
- Test: `test/mailbox.test.mjs`、`test/host.test.mjs`

**Interfaces:**
- Produces: `createMailbox({ windowMs = 5000, later = (fn, ms) => setTimeout(fn, ms), clear = (h) => clearTimeout(h), onFlush = () => {} })`
  - `.push(msg) -> Promise<result>`：累积一条，重置窗口；窗口到时调用 `onFlush(batch)`，`batch = { chatId, userId, texts: string[] }`，并把这一批所有 push 的 promise 用 `onFlush` 的返回值 resolve。
  - `.flushNow() -> void`：立刻触发（关闭/测试用）。
  - `.pending -> number`：当前窗口里积了几条。
  - `windowMs === 0` 时 `push` 同步 flush（等于关掉合并）。
- Consumes: `msg` 形状与 `normalizeMessage()` 一致（`{chatId, userId, text, ...}`）。

**语义（必须照这个来）：**
- 窗口从**最后一条**消息算起：每条新消息重置计时器。
- 同一批里 `text` 按到达顺序放进 `texts`；合并给模型时用 `'\n'` 连接。
- 合并后总长超过 4000 字：保留**最后** 4000 字，并在开头加 `（前面太长，没看完）`。
- `chatId` 变化时：先 flush 旧的，再开新的（当前只有一个主人，但别把两段对话混成一轮）。

- [ ] **Step 1: 写失败测试**（`test/mailbox.test.mjs`）

```js
test('三条 1 秒内连发：只触发一次，三条都在，顺序不变', async () => {
  const fired = [];
  const box = createMailbox({ windowMs: 5000, later: (fn) => { pending.push(fn); return pending.length; }, clear: () => {}, onFlush: (b) => { fired.push(b); return 'ok'; } });
  box.push({ chatId: 'private:42', userId: '42', text: '在吗' });
  box.push({ chatId: 'private:42', userId: '42', text: '睡了吗' });
  box.push({ chatId: 'private:42', userId: '42', text: '我跟你说个事' });
  assert.equal(fired.length, 0);
  fireLast();                      // 触发计时器
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0].texts, ['在吗', '睡了吗', '我跟你说个事']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-isolation=none "test/mailbox.test.mjs"`
Expected: FAIL — `Cannot find module '../src/mailbox.js'`

- [ ] **Step 3: 实现 `src/mailbox.js`**

要点：用一个 `timer` 句柄 + 一个 `waiters` 数组；每次 `push` 先 `clear(timer)` 再 `later(flush, windowMs)`；`flush` 把 `waiters` 全部 resolve 成 `onFlush` 的返回值。`windowMs === 0` 时 `push` 里直接调 `flush()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --test-isolation=none "test/mailbox.test.mjs"`
Expected: PASS（覆盖：连发合并 / 隔 6 秒分两次 / windowMs=0 立即 / chatId 变化先 flush / flush 后再 push 是新一批 / 超长保留尾部）

- [ ] **Step 5: 接进 host**

`createHost` 选项新增 `later`、`clear`、`mergeWindowMs`（默认 `5000`）。`handleEvent(ev)` 改成：归一化 → 校验（非私聊/空/超长截断，跟今天一样）→ `mailbox.push(msg)`；`onFlush(batch)` 里 `enqueue(() => runBatch(batch))`，`runBatch` 把 `text` 设为合并文本、把 `texts` 挂在 `msg.parts` 上传给 companion。

`memoryBlock(msg)` 改为：`render` 用合并后的 `text` 当 query；`remember` 对 `msg.parts ?? [msg.text]` 逐条入库（保留每条原话的粒度）。

- [ ] **Step 6: host 测试**

```js
test('mergeWindowMs: 0 时行为不变：三条各算一轮，各记一条记忆', async () => {
  const { ctx, host } = lifeSetup(['嗯'], 0, { mergeWindowMs: 0 });
  for (const text of ['在吗', '睡了吗', '我跟你说个事']) {
    await host.handleEvent({ post_type: 'message', message_type: 'private', user_id: 42, raw_message: text });
  }
  assert.equal(ctx.calls.length, 3, '关掉合并时仍是三次');
  assert.equal(host.memory.card().records.length, 3);
});
```

合并窗口的用例单独写一个（注入 `later` 收集回调，手动 fire），断言 `ctx.calls.length === 1`、`messages` 里那条 user 文本包含三句、`records.length === 3`。

- [ ] **Step 7: 跑全量**

Run: `npm test`
Expected: 全绿；原有「一句话只调一次模型」用 `mergeWindowMs: 0` 保持原样

- [ ] **Step 8: 提交**

```bash
git add src/mailbox.js test/mailbox.test.mjs src/host.js test/host.test.mjs
git commit -m "feat: 连发消息 5 秒安静窗口合并（避免每句一次调用）"
```

---

### Task 2: 颜文字保护（按括号深度切分）

**Files:**
- Modify: `src/message.js:62-85`（`splitReply`）
- Test: `test/message.test.mjs`

**Interfaces:**
- Produces: `splitReply(text, { max = 4, maxChars = 300 })` — 签名不变，行为改成「括号内的句末标点不算句末」。

**语义：**
- 成对括号：`（）`、`【】`、`「」`、`()`、`[]`、`{}`，可嵌套。
- 深度 > 0 时遇到的 `。！？!?…；;` 不切。
- 长度超过 `maxChars` 需要硬切时，优先切在深度 0 的位置；**找不到就原地硬切**（绝不因为括号没闭合就不切）。
- 括号没闭合时，深度在结尾被丢弃，不跨段累积。

- [ ] **Step 1: 写失败测试**

```js
test('颜文字不能被拦腰切断', () => {
  const long = '好累啊'.repeat(80) + '(´；ω；｀)' + '真的'.repeat(80);
  const parts = splitReply(long);
  assert.ok(parts.some((p) => p.includes('(´；ω；｀)')), JSON.stringify(parts));
});

test('括号没闭合也不能卡住：照样切出来', () => {
  const parts = splitReply('啊'.repeat(400) + '（没闭合' + '。' + '后面还有');
  assert.ok(parts.length > 0);
  assert.ok(parts.every((p) => p.length <= 300));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-isolation=none "test/message.test.mjs"`
Expected: FAIL — 颜文字被切成两段

- [ ] **Step 3: 实现**

用一次扫描代替 `String.match`：遍历字符，维护 `depth` 与 `buf`；遇到开括号 `depth++`，闭括号 `depth = Math.max(0, depth - 1)`；深度 0 且遇到句末标点时把 `buf` 推入 `parts`。超长时在当前 `buf` 里从末尾往回找最近的深度 0 位置，找不到就在 `maxChars` 处硬切。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --test-isolation=none "test/message.test.mjs"`
Expected: PASS（新增 4 条 + 原有拆条用例不回归）

- [ ] **Step 5: 提交**

```bash
git add src/message.js test/message.test.mjs
git commit -m "fix: 按括号深度切分，颜文字不再被拦腰切断"
```

---

### Task 3: 旧事实失效（`supersededAt`）

**Files:**
- Modify: `src/memory/card.js`（`remember` 新增 `supersedes` 判定；`rankForPrompt` / `render` / `stats` 过滤；新增 `undoSupersede`）
- Modify: `src/panel.js`（记忆列表显示「已被后来的说法覆盖」+ 「恢复」链接）
- Modify: `src/host.js`（面板 `?unsupersede=` 路由）
- Test: `test/memory-card.test.mjs`、`test/panel.test.mjs`

**Interfaces:**
- Produces: `remember(card, text, { ..., now })` — **不新增参数**，覆盖判定在内部做（规则版）。
- Produces: `undoSupersede(card, id) -> card`
- Produces: `isLive(rec) -> boolean`（`forgottenAt === undefined && supersededAt === undefined`）

**覆盖判定（保守版，必须同时满足）：**
1. 新句里出现变化词：`走|走了|没了|不在了|分了|分手|离职|搬走|不养|不在了|结束了|改了|换了|不是了` 之一；
2. 与某条**活着**的旧记录共享一个 ≥2 字的连续片段（用两字窗交集判断，交集非空即可）；
3. 这条旧记录不是锚点（`pinned` / `first`）——锚点是「第一次相遇」「他亲口说要记住的」，不能被后来的话冲掉。
4. 每次最多覆盖 **1** 条（交集最大的那条），避免一句话误杀一片。

- [ ] **Step 1: 写失败测试**

```js
test('新说法覆盖旧事实：旧的还在，但不再注入', () => {
  let card = remember(createCard(0), '他养了只猫，叫团子', { now: 1 });
  const oldId = card.records[0].id;
  card = remember(card, '团子走了', { now: 2 });
  assert.equal(card.records[0].supersededAt, 2);
  assert.doesNotMatch(render(card, { now: 3 }), /养了只猫/);
  assert.equal(undoSupersede(card, oldId).records[0].supersededAt, undefined);
  assert.match(render(undoSupersede(card, oldId), { now: 3 }), /养了只猫/);
});

test('不相干的话不会覆盖：宁可有两条矛盾的，也不要错误地删掉一条', () => {
  let card = remember(createCard(0), '他养了只猫，叫团子', { now: 1 });
  card = remember(card, '他今天走了两万步', { now: 2 });
  assert.equal(card.records[0].supersededAt, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-isolation=none "test/memory-card.test.mjs"`
Expected: FAIL — `supersededAt` 未定义

- [ ] **Step 3: 实现判定与过滤**

在 `remember` 里新记录入栈后跑一次 `findSupersedeTarget(card, text, now)`，命中就给旧记录写 `supersededAt = now` 并记入 `stats.superseded`。`render` / `rankForPrompt` / `stats` 统一用 `isLive()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --test-isolation=none "test/memory-card.test.mjs"`
Expected: PASS（覆盖：真覆盖 / 不相干不覆盖 / 锚点不覆盖 / 一句话最多覆盖一条 / `undoSupersede` 后又能注入）

- [ ] **Step 5: 面板与路由**

面板记忆列表：被覆盖的条目加一行 `（已被后来的说法覆盖）` + `<a href="?unsupersede=<id>">恢复</a>`；host 的 `/panel` 加 `unsupersede` 查询参数（和 `restore` 同一条信任闸门）。

- [ ] **Step 6: 提交**

```bash
git add src/memory/card.js src/panel.js src/host.js test/memory-card.test.mjs test/panel.test.mjs
git commit -m "feat: 新说法会让旧事实失效（可撤销，锚点不动）"
```

---

### Task 4: 检索评测（先有数字，再谈改进）

**Files:**
- Create: `test/memory-eval.test.mjs`
- Create: `docs/memory-eval.md`（跑出来的基线数字与本机结论）

**Interfaces:**
- 测试里自带一份固定记忆卡（约 24 条，覆盖 identity / event / chatter），以及 3 组题：
  - **命中组** 10 题：每题一个 query 和一条期望文本，要求它出现在 `rankForPrompt(card, {query}).slice(0, 3)` 里。
  - **无关组** 5 题：与卡里任何记录都无关的 query，要求 `search()` 返回空（不硬凑）。
  - **诱捕组** 3 题：问库里根本没有的事，要求 `render()` 不出现任何看似回答它的句子（用「期望匹配的关键词不出现」表达）。

- [ ] **Step 1: 写评测（先跑一次，把基线记下来）**

```js
const CARD = /* 24 条固定记录，含：过敏、生日、养猫叫团子、面试、搬家、语音条数闲聊…… */;

test('命中率：10 题里至少 8 题的期望记录进前 3', () => {
  const miss = HITS.filter(({ q, want }) => !rankForPrompt(CARD, { now: T, query: q }).slice(0, 3).some((r) => r.text.includes(want)));
  assert.ok(miss.length <= 2, `没进前 3：${JSON.stringify(miss)}`);
});
```

- [ ] **Step 2: 跑，把实际数字写进 `docs/memory-eval.md`**

Run: `node --test --test-isolation=none "test/memory-eval.test.mjs"`
Expected: 先不管过不过，**记录命中/未命中、噪音条数、丢失条数**。这就是基线。

- [ ] **Step 3: 按基线修，一次只改一处**

如果命中 < 8/10：**先加绝对门槛**——`search()` 里 `if (score < 0.15) continue`（现在只要 `bm25 > 0` 就算命中，无关查询也能凑出一条）。改完重跑，记下新数字。
仍不够才动第二处：`recency` 的 `0.7 + 0.3·e^(−天/30)` 改成 `0.6 + 0.4·…`（让最近的事更容易压过旧事）。每处单独提交，不重写检索。

- [ ] **Step 4: 跑全量**

Run: `npm test`
Expected: 全绿，且 `docs/memory-eval.md` 里记下改前/改后两组数字

- [ ] **Step 5: 提交**

```bash
git add test/memory-eval.test.mjs docs/memory-eval.md src/memory/search.js
git commit -m "test: 记忆检索评测（命中/无关/诱捕），并记下基线数字"
```

---

### Task 5: 自述（每周一次的三类认识）

**Files:**
- Create: `src/insights.js`
- Modify: `src/host.js`（`insightsStore`、心跳里按周刷新、注入、面板）
- Modify: `src/panel.js`（她的房间：最近三条自述）
- Test: `test/insights.test.mjs`、`test/host.test.mjs`

**Interfaces:**
- Produces: `createInsights(now) -> { at: number, lines: {kind, text}[] }`
- Produces: `dueInsights(insights, now) -> boolean`（距上次 ≥7 天；`at === 0` 时也 true）
- Produces: `composePrompt(card, { now }) -> string`（把 top 12 条记忆按种类列出来，要求三类各写一句，每句 ≤40 字，无话可写就写 `-`）
- Produces: `parseInsights(text) -> {kind, text}[]`（`kind ∈ {work, us, growth}`；认不出的一律丢弃；每类最多保留 1 条新句）
- Produces: `applyInsights(insights, lines, now) -> insights`（每类最多 20 条，去重，新的在后）
- Produces: `renderInsights(insights, { limit = 2 }) -> string`（每类取最新一条，拼成 `【你最近的想法】我…；我们…；我学到了…`；没有就返回空串）

- [ ] **Step 1: 写失败测试**

```js
test('三类各一句，认不出的类别直接丢', () => {
  const lines = parseInsights('work|最近总在等他说完话才敢说自己的\nus|我们最近聊得少，但我不慌\nnonsense|随便\n');
  assert.deepEqual(lines.map((l) => l.kind), ['work', 'us']);
});

test('一周一次：昨天写过就不再写，隔了 8 天再写', () => {
  const ins = applyInsights(createInsights(0), [{ kind: 'us', text: '我们最近挺稳' }], 1000);
  assert.equal(dueInsights(ins, 1000 + 6 * 86400e3), false);
  assert.equal(dueInsights(ins, 1000 + 8 * 86400e3), true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-isolation=none "test/insights.test.mjs"`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/insights.js`**

纯函数，不读文件。`composePrompt` 只列真实记忆（带清晰度标签），并要求「写不出来就写 `-`，不要编」。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --test-isolation=none "test/insights.test.mjs"`
Expected: PASS（覆盖：解析、丢弃未知种类、每类上限 20、去重、`renderInsights` 为空时不注入）

- [ ] **Step 5: 接进 host**

`insights.json` 存 `{at, lines}`；心跳里 `dueInsights()` 为真时跑一次（`complete`，`maxTokens: 300`，system 用她的人格卡）；成功才 `applyInsights` 并落盘；失败只 `log.warn`，下次再来。`contextBlock()` 里把 `renderInsights()` 加在「她的当下」之前。

暴露 `host.insights = { state: () => 读盘, refresh: () => enqueue(refreshInsights) }`（和 `host.life/diary/budget` 同形）。

失败时**不推进 `at`**（否则一次失败要等一周）。

- [ ] **Step 6: host 测试 + 面板**

```js
test('自述：一周一次，写进上下文，面板看得见', async () => {
  const { ctx, host, dataDir, ask } = lifeSetup([
    'work|最近总在等他说完话才敢说自己的\nus|我们最近聊得少，但我不慌\n-',
    '嗯',
  ], 0);
  writeFileSync(join(dataDir, 'insights.json'), JSON.stringify({ at: 0, lines: [] }));
  await host.insights.refresh();
  await ask();                                   // 下一句才看得见上下文
  assert.match(systemOf(ctx.calls.at(-1)), /【你最近的想法】/);
  assert.match(renderPanel({ state: initState(0), memory: createCard(0), insights: host.insights.state(), now: 0 }), /最近的想法/);
});
```

面板「她的房间」加一节：最近三条自述（带日期）。

- [ ] **Step 7: 跑全量**

Run: `npm test`
Expected: 全绿

- [ ] **Step 8: 提交**

```bash
git add src/insights.js test/insights.test.mjs src/host.js src/panel.js test/host.test.mjs test/panel.test.mjs
git commit -m "feat: 每周一次的自述（三类认识，各自有界）"
```

---

## 本手册之外（下一步再说）

不做进这一批，理由是要么是产品决定，要么依赖前四项的数字：

| 项 | 为什么押后 |
|---|---|
| 她在忙时回得短 / 晚点回 | 需要先把连发合并的手感调好，否则两种延迟叠在一起分不清 |
| 主动搭话的诚实框架（禁止「我一直在等你」） | 依赖主动搭话真的开启；现在默认关，改了也看不见 |
| 睡眠时段不回消息 | 产品决定，需要你点头 |
| 同日上下文、记忆摘要折叠 | 等 Task 4 的数字，别凭感觉加预算 |
| 语音 / 图片收发、QQ 空间、游戏 | 另一条产品线 |

## 执行顺序与理由

1 → 2 → 3 都是小修，彼此独立，半天内能全绿；4 是「先量再改」，必须在 5 之前（否则改检索没有判据）；
5 最大，放最后，因为它依赖记忆卡的质量已经说得过去。

## 验收

- `npm test` 全绿，新增测试覆盖上表「Review Focus」五条。
- 面板能看见：被覆盖的记忆（可恢复）、最近三条自述、连发合并后的一轮对话。
- `docs/memory-eval.md` 里有改前/改后两组数字。
