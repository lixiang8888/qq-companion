# 参考项目与采纳记录

> 只看「能直接改进本项目」的部分；判断依据是源码/README 的实际做法，不是 star 数。

## surf-core（SLNE-Development）

**不是 DSH 项目。** 是 Minecraft 服务端库（[docs.slne.dev/surf-core](https://docs.slne.dev/surf-core/installation)，npm 包 `surf-core`）。与本项目无交集。

## deepseek-harness-digital-life（多数字生命）

<https://github.com/nefelibata5136-code/deepseek-harness-digital-life> · 27★ · MIT · v0.2.0

多「数字生命」的基础设施：World/Supervisor、`lifeId`、独立 worker、私有空间、耐用消息、Room/Inbox、
Schedule、委派、记忆基础设施、可选 B站 MCP。绑 DSH 0.2.0-rc.2，需要 Node + Python，Windows。

**判断：不采用。** 形态不对——我们要一个陪伴体，不要一个世界。它没有 QQ 通道，也没有情绪/关系/人格。
可参考的只有两点：`context_compact` 自管检查点（与我们 `session.js` 的压缩同向），
以及「记忆是基础设施、不是提示词」这个定位。

## SurfCore（Mieksido/surfcore）—— 同源，且是最接近的完整实现

<https://github.com/Mieksido/surfcore> · v0.6.0 · MIT（package.json）· 2026-10-26 建仓，当天仍在推

**和 dsh-qq 是同一套代码的血缘**，证据：依赖完全相同（`@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`、`@snowluma/sdk`、`zod`），
脚本名重合（`test-qq-preset-contract`、`verify-dsh-020-adaptation`、`patch-snowluma-sdk`），
文件名重合（`bridge.js`、`role-card.js`、`preset-prompt.js`、`md-to-plain.js`、`state-acl.mjs`、`token-ledger.js`）。
它是「双进程」形态：DSH 插件（设置页/记忆卡/B站/桌宠）+ 独立桥接进程（QQ/控制台/安全闸门）。

**它已经做完的**（我们没有，而且做得比我们细）：

| 能力 | 实现 | 可借的点 |
| --- | --- | --- |
| 记忆衰减 | `memory-card.js`（90KB）：四档清晰度 vivid→clear→fuzzy→trace，每天最多降一档，停机后按天数补跑 | 「慢慢模糊」而不是到期删除 |
| 全量存档 | append-only `memory-card-full.jsonl`，不注入、只检索 | 遗忘的东西仍可查回 |
| 重要度 | 纯函数打分（主人私聊 +42、情绪浓度 +24…），不调模型 | 可解释、可回滚 |
| 锚点 | 置顶 / 初次相遇 / 主人重要记忆（≥65）永不遗忘 | 防止「把关系最早的记忆忘了」 |
| 容量 | 80/90/100% 告警，满 100% 自动压到 90%；注入上限 2200 字 | 我们缺的正是这条硬闸 |
| 隐私 | scope（qq/bili/shared/pet）+ 入库前脱敏（手机号/证件/链接/密钥） | 我们的 store 还没脱敏 |
| 摄取 | 桥接只 append 到 inbox，插件是唯一写者，10 分钟整理一次 | 避免双进程抢写 |

**它没有的**：`src/` 下没有 emotion / mood / relationship / personality 任何文件。情绪、关系数值、人格漂移是空白。

## dsh-character-presets（露娜模式）

<https://github.com/wwwangzilin/dsh-character-presets> · MIT · DSH 0.2+

十角色共用一套**确定性规则引擎**：感知 → 理解 → 状态 → 表达 → 调节 → 记忆，模型只读引擎输出的结构化文本。`emotion_sense` 工具每轮返回一屏指引。179 项纯函数测试。

| 做法 | 我们的状态 |
| --- | --- |
| 情绪判定：否定翻转、强度分档、混合情绪（气笑） | **已采纳** → `src/affect/appraise.js`（65 项测试里有 6 项专门钉它） |
| 记忆写入五道闸：逐字引用、来源分类、事实来源、谓词白名单、数字出处 | 待采纳（做记忆库时，防止模型编造） |
| 三通道召回（关键词 / 情绪效价 / 时近）+ RRF 融合 | 待采纳（比我们现在线性加权更稳） |
| 遗忘 = 抑制不删除，依赖它的推断重算 | 待采纳（和手册“印象不改写”同向） |
| 粘滞工作/闲聊状态机（进入 6 轮保持） | 参考（私聊场景可简化为「专注/闲聊」两档） |

## dsh-memory-core

<https://github.com/KikaiLastest/dsh-memory-core> · MIT

纯文件记忆（Markdown + JSONL，无数据库），2-gram + BM25-lite，召回预算 150ms。

| 做法 | 我们的状态 |
| --- | --- |
| **记忆使用协议**：历史参考不是本轮发言、可能过期、要能追溯、以新事实为准、不许编造 | 待采纳 → 应加进 `session.js` 的 system 尾部 |
| **导航索引**（≤600 字，只有主题和首句）常驻，而不是每轮注入全文 | 待采纳 → 比“每轮 top-k 全文”省得多 |
| 写入前脱敏（`sk-` / `ghp_` / `Bearer` / `token=` …） | 待采纳 → 加到 `store.js` 写路径 |
| 诚实的超时表述：「协作式检查 + 主动熔断」，不是硬实时 | 参考（写文档时照这个口径） |
| 后台总结：空闲 30 分钟 + 内容 hash 水位保证幂等 | 已类似 → 我们的 `session.js` 压缩也算水位，但没有文件级总结 |

## dsh-companion（人设卡）

<https://github.com/suis077/dsh-companion> · MIT

人设卡经 `systemPrompt.section` 注入（每会话可单独关），记忆 JSON：`affinity` / `mood` / `traits` / `chapters`。

| 做法 | 我们的状态 |
| --- | --- |
| **记忆上限 200 条，超出把最旧的折成一条摘要**（不是丢弃） | 待采纳（我们的压缩只压对话，不压印象） |
| **变化即备份**：`.bak` + 外部快照 + 最多 30 份时间戳 | 待采纳（我们只有临时文件 + rename） |
| 独立的「记忆守则」提示段，防止把每次读文件都记成流水账 | 待采纳 |
| 明说「好感度不是真实关系的度量」 | 已同向（我们的 guard/trust 也不对外声称） |

## 2026-11 追加的一批（主动搭话 / 天气 / 看视频 / B站）

只读 README 与设计说明，未复制代码。许可证与「借了什么」见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

### dsh-see-now（让 AI 实时看见屏幕）—— **这批里影响最大的一个**

<https://github.com/SAOS-3624/dsh-see-now> · Apache-2.0 · v0.2.1

**判断：它的抓屏管线不采用，它的两条思想全部采用。**

| 它的做法 | 我们用在哪 |
| --- | --- |
| 每帧先打 0–255「变化分」（64×36 网格上的像素差），只留「换了一张」或「攒够了运动量」的 | `src/video.js` 的 `changeScore`——**但改用逐通道而不是灰度**（见下） |
| 留下来的 4~8 帧**拼进同一张图**：一张图里塞几帧价格差不多 | `packSheet` |
| 宽度对齐 **42px** patch 网格：800 会被 pad 到 812 白算一列，798 正好 19 列 | `SHEET_WIDTH = 798`、`SHEET_HEIGHT = 462` |
| 只传「变了的帧」，静止屏幕几乎不出图 | 视频只抽 90 秒、每 2 秒一帧，再挑 ≤6 帧 |

**唯一没照它做的地方**：它用 HSV 加权，我们第一版图省事用了灰度，真机一测红→绿只拿到 17 分
（「换了一整屏」被判成「没怎么变」），改成逐通道平均差后 128/127。这条记在 `docs/design/06` 里。

它另外还有悬浮窗 + `say` 通道（AI 说话并被念出来），和 `dsh-watch-together` 同一协议——
那是另一种产品形态（对桌面说话，不是对 QQ 说话），本项目没接。

### 主动性：三个 DSH 心跳插件

<https://github.com/zy666946/dsh-heartbeat-inner> · MIT　—— 期待时间 / `{send, waitMinutes}` 决策 JSON / 退避
<https://github.com/john-walks-slow/dsh-proactive> · MIT　—— 宿主级调度、静默轮次不污染上下文
<https://github.com/Kanadego/dsh-heartbeat> · MIT　—— 闸门先于模型、心事匣、节律随机化

三个都没有直接装：它们服务的是 DSH agent，本项目是自己管循环、没有工具面。
只把「什么时候该想起他」这套判断搬进了 `src/proactive.js`。

### dsh-environment-context

<https://github.com/liqiming-whu/dsh-environment-context> · MIT

时间/天气/地点/电量的环境上下文注入，天气源按 Open-Meteo → MET Norway → wttr.in 容错，
用系统提示段注入而不是产生聊天消息。我们只取了第一路（实测值）和「注入而非消息」这条。

### 刷 B站：四个都读过，一个都没装

[dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)、[dsh-deepmoyu](https://github.com/pyyxzi/dsh-deepmoyu)、
[dsh-bili-eyes](https://github.com/QiuYeDx/dsh-bili-eyes)、[dsh-bili-mini](https://github.com/tuanzhanghao/dsh-bili-mini)。

**判断：不采用。** 它们是**给 DSH agent 的工具插件**（注册 `bili_*` 工具，宿主在 agent 会话里喂给模型），
而本项目的对话是一次 `ctx.llm.stream` 的裸调用，**没有工具面**——装上也不会让 QQ 里的小鲸鱼会刷 B站，
只会让 DSH 窗口里那个 agent 会。真要做，只能像天气/查真事那样自己写 HTTP 客户端。

顺带一条选型记录：`dsh-deepmoyu` 是照着「鲸鱼娘」做的，和本项目的人格（DeepSeek 小鲸鱼）**撞身份**，
就算以后要装也只能二选一。

## 还没读的

`ccawmiku/dsh-salon`（陪伴群聊+私聊）、`zuoyunlai/dsh-pet-plugin`（桌宠 + TTS）、`ailreth/xiaoxiao-persona-core`、`@m-rui/dsh-mate-companion`（npm）、`dsh-self`（npm）。

## 我们的差异（别为了对齐而丢）

1. 关系是**四个数值**（trust/intimacy/guard/debt）带惰性结算，不是单一好感度；
2. 人格是**五特质 + 月更 + 快照回滚**，不是字符串数组累积；
3. 对话循环和压缩**自己管**，不依赖 DSH 会话的窗口策略。
