# 她的生活（companion-life）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让陪伴体有一个真实的「当下」（此刻在做什么、到几点）和一个真实的「昨天」（每天读差分写一条日记），并让她和你能看到。

**Architecture:** 新增 `src/life.js`（纯状态机）与 `src/diary.js`（差分 + 落盘），由 `host.js` 每轮驱动、写 `life.json` 与 `diary/*.md`，注入 system prompt，面板渲染「她的房间」。全部纯函数 + 注入时钟，离线可测。

**Tech Stack:** Node 24 ESM、node:test、无新依赖。

**Spec:** `docs/progress.md`（讨论结论与约束）+ `.planning/2026-10-28-companion-life/task_plan.md`

## Global Constraints

- 事件只能来自真实差分（记忆降档/遗忘、压缩次数、沉默时长、重启缺口、人格卡 mtime），**禁止随机事件表**。
- 日记与「我是谁」由模型写，插件不代笔，不编造内容。
- 不新增运行时依赖；不引入新的外部服务。
- 所有新模块接受 `now` 注入；测试不依赖真实时间。
- 缺数据时宁可不注入，不写占位句子。

## Review Focus

- 她「在做什么」和真实时间冲突（半夜说在上班）——比不做还糟。
- 差分取不到（首次运行、文件缺失）时日记写成空话。
- 时区/跨午夜：23:00 的日结可能落在本地日界的另一侧。
- 面板渲染日记时的 HTML 转义。
- 重启后 `life.json` 过期（`until` 早已过去）却没被清掉。

---

### Task 1: `src/life.js` —— 她的当下

**Files:**
- Create: `src/life.js`
- Test: `test/life.test.mjs`

**Interfaces:**
- Produces: `createLife(now) -> {doing: string, until: number, nextWakeAt: number, updatedAt: number}`
- Produces: `advance(life, now) -> life`（`until <= now` 时清空 doing）
- Produces: `applyPlan(life, plan, now) -> life`，`plan = {doing: string, minutes: number}`
- Produces: `parsePlan(text) -> {doing, minutes} | null`（解析模型输出 `在看书|30`）

- [ ] **Step 1: 写失败测试**

```js
test('到点后清空：不再报告在做什么', () => {
  let life = createLife(T0);
  life = applyPlan(life, { doing: '在看书', minutes: 30 }, T0);
  assert.equal(advance(life, T0 + 10 * 60e3).doing, '在看书');
  assert.equal(advance(life, T0 + 31 * 60e3).doing, '');
});
```

- [ ] **Step 2: 跑测试确认失败**（`node --test --test-isolation=none "test/life.test.mjs"`）
- [ ] **Step 3: 实现**：`advance` 比较 `until`；`parsePlan` 用 `/^(.+?)[|｜]\s*(\d+)$/m`，minutes 夹在 5~180
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**（`git add src/life.js test/life.test.mjs && git commit -m "feat: life state machine"`）

### Task 2: 注入 —— 她知道此刻在干什么

**Files:**
- Modify: `src/host.js`（`memoryBlock` 之后拼 `lifeLine`）
- Test: `test/host.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `advance` / `applyPlan`
- Produces: `lifeLine(life, now) -> string`（空状态返回 `''`）

- [ ] **Step 1: 写失败测试**：`life.doing = '在收拾东西'` 时，发给模型的 system 包含「你此刻：在收拾东西」；`doing` 为空时不包含
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**：host 启动时读 `life.json`（损坏回 `createLife`），每轮 `advance` 后拼进 `context`
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

### Task 3: `src/diary.js` —— 差分与日记

**Files:**
- Create: `src/diary.js`
- Test: `test/diary.test.mjs`

**Interfaces:**
- Produces: `snapshot({affect, card, session, now}) -> {forgotten, faded, compactions, size}`
- Produces: `diff(prev, cur, {now, lastUserAt}) -> {forgotten, faded, compactions, idleHours, size}`
- Produces: `composePrompt(date, d) -> string`
- Produces: `writeDiary(dir, date, text) -> path`

- [ ] **Step 1: 写失败测试**：两条 trace 被遗忘 → `diff.forgotten === 2`；`composePrompt` 只包含真实数字
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**：`faded` 统计 `clarity` 档位下降的条数（用 `recallCount` 之外的字段不做推断）；`writeDiary` 建目录、写 `YYYY-MM-DD.md`
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

### Task 4: 面板「她的房间」

**Files:**
- Modify: `src/panel.js`、`src/host.js`（`/panel` 传 `life` 与最近 3 天日记）
- Test: `test/panel.test.mjs`

- [ ] **Step 1: 写失败测试**：`life.doing='在看书'` 时面板含「在看书」；日记文本被转义（`<script>` 不变标签）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**：新 section「她的房间」，列出 doing / 下一个闹钟 / 最近 3 天日记
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交**

---

## 执行顺序与理由

1 → 2 先做：没有「当下」，注入和日记都没有素材；3 依赖记忆卡已有的 `clarity/forgottenAt`；4 最后，纯展示。

## 不做（本计划范围外）

- token 饭（要等确认 DSH 能否读余额）
- 游戏、QQ空间、B站、语音、群聊
- 主动搭话的改动（已有六道闸，先不动）
