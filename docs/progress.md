# 进度

## 已完成并验证（143 项测试，`npm test`）

| 模块 | 文件 | 验的是什么 |
| --- | --- | --- |
| 四层状态 | `src/affect/core.js` | 衰减、日封顶、guard 单调、修复比例、**被认真对待会加温（日封顶）**、漂移限幅、重放哈希、时钟回拨、结算幂等 |
| 规则评估 | `src/affect/appraise.js` | 夸/骂/追问；否定翻转、强度外溢、混合情绪、倾诉不记账 |
| 人格漂移 | `src/affect/personality.js` | 证据 ≥5 次且跨 ≥3 天、一月只结算一次、单次限幅、20 版快照、回滚、自我叙事 |
| 情绪化行为 | `src/affect/behavior.js` | 心情好回得快、可补一句；被戳到只发一条；戒备高更慢；延迟有上下限 |
| 主动搭话 | `src/proactive.js` | 期待点（她说完一轮后按他平时回复间隔算，深夜推到早上八点）+ 连发上限 2 条；安静时段/每日上限/冷却/心情/想的次数护栏全过才想一次；「想」是独立调用，不写主历史 |
| 注入块 | `src/affect/inject.js` | 状态变→措辞变；叙事优先于特质词；≤200 字；明说“不要说出口” |
| 记忆卡 | `src/memory/card.js` | 重要度、四档清晰度、每天一档、停机补跑、锚点永不遗忘、注入上限、按 query 召回、**条数安全阀（淘汰不动锚点）** |
| 记忆检索 | `src/memory/search.js` | 中文二元切词 + BM25-lite × 重要度 × 清晰度 × 新近；无关查询不硬凑 |
| 脱敏 | `src/memory/sanitize.js` | 密钥/令牌/手机号/证件号替换，普通聊天不误伤 |
| 自检面板 | `src/panel.js` | **体检（她为什么不回话：主人/网关/地址/模型/人格卡逐项 ✅❌）**；状态/人格/记忆/运行一页看完；**最近对话（谁说了什么，长句截断）**；记忆文本转义；**人格回滚、记忆置顶/忘记**；**设置表单（改 ownerQQ/地址/token/人格，留空不改）** |
| 消息映射 | `src/message.js` | 私聊/群/at/图片/未知段；拆条（超长按句末再拆，不甩小作文） |
| OneBot | `src/onebot.js` | 鉴权、三态、退避、错误原因、私聊/群发送 |
| 陪伴体 | `src/companion.js` | 只服务主人私聊；骂了关系真的变差；每轮登记人格证据；记忆块失败不挡回复 |
| 会话 | `src/session.js` | 多轮、压缩、压缩失败不丢历史、**摘要超 1200 字再压/截尾**、会话落盘重启接着聊、记忆使用协议（5 条）、**system 可以是 getter（每轮现读人格卡）**、**空回复不写进历史** |
| LLM | `src/llm.js` | dsh-llm 流式契约、reasoning 不进正文、错误码透传、**assistant 带 id+source（真机契约）** |
| 落盘 | `src/store.js` | 原子写 + **变化即备份 .bak** + 坏文件留证 |
| 插件入口 | `src/host.js` | 配置/人格落盘、路由、每轮维护记忆并注入、写入前脱敏；**启动失败不炸宿主**；**入站串行队列**；**改连接参数自动重连** |
| 清单体检 | `test/bundle.test.mjs` | patch/exports/locale/icon 与真实文件对得上 |
| 安装形态 | `test/install-shape.test.mjs` | 放进 node_modules 后**按包名能解析、能加载、无外部依赖** |
| 自检 | `src/preflight.js` + `scripts/preflight.mjs` | 配置/owner/地址/人格/数据逐项体检；`--online` 真连一次 OneBot（只读） |
| 装载检查 | `src/install-check.js` | 依赖 / bundles / patch 行 / node_modules **四处证据**，缺一处就报「装了也不会加载」 |
| 真机探测 | `src/live-check.js` + `scripts/verify-live.mjs` | 只读 GET 插件接口，把网关状态翻译成下一步动作 |
| 长跑 | `test/long-run.test.mjs` | 默认 90 天 × 4 句：历史/摘要/记忆条数都停在区间内，锚点还在，特质与关系不跑飞；`QQC_DAYS=365` 跑满一年 |
| 真机探测 | `src/live-check.js` + `scripts/verify-live.mjs` | 只读 GET 插件接口，把网关状态翻译成下一步动作 |
| 端到端 | `test/integration.test.mjs` | 一条私聊事件 → 拆两条 → **真的 POST 到本地假 OneBot**，payload 正确；连发两条不串序；重启接着聊 |
| 长跑 | `test/long-run.test.mjs` | 默认 90 天 × 4 句：历史/摘要/记忆条数停在区间内、锚点还在、特质与关系不跑飞；`QQC_DAYS=365` 跑满一年 |



## 安装（已按官方文档核实）

DSH 侧栏 **Plugins → Add plugin** → 填绝对路径 `D:\大烧货\工作区\qq-companion`。

依据 `dsh-plugin-manager` 的 README：`inspect(spec)` 接受绝对路径（读它的 `package.json`），
`installBundle` 接受路径 / tarball / git / 注册表；`link:` 只对 Source Web 与开发版 Desktop 提供，
生产版 Desktop 会按 `file:` 复制安装（改代码要重装）。**不要**手改 profile 的
`package.json` / `cordis.patch.yml`，也不要自己在 profile 里跑 pnpm。

## 已核实的 DSH 事实

- 版本 `0.2.1-rc.3`；源码在 `app.asar` 的 `dsh/node_modules/@deepseek-ai/`，`scripts/asar.mjs` 可直接读。
- `ctx.llm.stream({provider, model, messages, maxTokens?, temperature?})` → `{type:'text-delta',text}` +
  `{type:'finish',reason:{kind:'done'|'error'|'aborted',failure?}}`。
- 消息形状（`dsh-llm` README + `lib/index.js` 的 `forAdapter`）：**user 可以 request-only**（只带
  `role`/`content`），**assistant 必须 durable**——核心层读 `message.source.replayState`、deepseek 适配层读
  `message.source.kind`，缺 `source` 会抛 TypeError 并被包成 `finish{kind:'error'}`（真机上表现为
  「模型调用失败：UNKNOWN」）。所以 `src/llm.js` 自己给 assistant 补 `id`（randomUUID）和
  `source:{kind:'model',provider,model}`，system 补 `source:{kind:'system-prompt'}`。`content` 一律是
  block 数组（`[{type:'text',text}]`），不是裸字符串。
- 插件导出形式：`export function apply(ctx, config)`，可选 `export const inject` / `Config`；
  资源必须用 `ctx.effect`/`ctx.on` 注册并返回清理函数。
- bundle 清单要点：`dsh.bundle.patch` + `exports['.']` + `locale/*.json` 的 `meta.title/description` + 图标。
- Web 路由（`dsh-host-webserver` 源码取证）：服务名 `ctx.webServer`，`register({kind:'exact'|'prefix',
  path, handler})`，**返回注销函数**，handler 自己写响应；重复 (kind,path) 会抛。我们的 `/qq-companion/api/*`
  正是这么注册的。
- **cordis 的服务是代理：没写进 `inject` 的服务名一旦被读取就抛**（`cannot get property "webServer"
  without inject`），不是返回 undefined。inject 里的服务同时是「必填」——宿主会等它就绪才 apply。
  我们的 `inject = ['llm', 'webServer']`：面板是核心功能，缺 webServer 的 profile（比如 headless）本来也没 UI。
  可选服务要用 `ctx.get('名字')`，它不抛。

## 下一步

1. 真机：SnowLuma 开着 → `Add plugin` 填绝对路径 → 面板填 `ownerQQ` / OneBot 地址 / token → 发一条私聊。
   装得上、能加载、面板能开、两轮收发都已经自测过了；真机要验的是**真的 SnowLuma 和真的模型**这两段。
2. 真机调参：主动搭话节奏、情绪权重、拆条长度——只有真实作息能定。
3. ~~给这个目录建 git 仓库~~：2026-10-28 已经 `git init`，基线 + 四个任务各一个提交。
4. 已知没有的东西：工具调用（联网搜索/看图）。自管循环牺牲了它，要补得自己接 API。
5. token 饭（她自己会心疼 API 额度）——已做，见下节。

## 她知道自己刚才不在（2026-10-28）

第四面墙最后一块：让她知道「我不在的时候，时间是过的」。

- `alive.json` 只存一个时间戳，开机写一次、心跳每 10 分钟写一次。
- 开机时算出「上次醒着」和中间的空白，**只在空白 ≥30 分钟时说**，而且**开机两小时内**说完就过期——
  否则就变成每句话都在提醒她死过一次。
- 说出口是这样的：
  `你刚才不在了 9 小时 46 分（上次醒着是 昨天 22:14）。那段时间你没有记忆——不是忘了，是那会儿没有你。`
- **睡眠也算**：两次心跳间隔超过 20 分钟，说明进程被冻住了（合盖、待机），那段时间她同样不存在。
  只有关机才停的心跳、和睡眠冻住的心跳，在这里是同一件事。

## 钱：余额是真的，token 是她自己的（2026-10-28）

一开始以为只能自己数，查过 DSH 内部之后发现两条更好的路：

| 来源 | 能回答什么 | 结论 |
|------|------------|------|
| `GET https://api.deepseek.com/user/balance`（key 走 `ctx.credentials.resolve('DEEPSEEK_API_KEY')`） | 账户还剩多少钱 | **采用**，本机实测 200 |
| `ctx.tokenMeter`（`dsh-token-meter`） | 会话的 token 用量 | 用不上：它回放**持久会话日志**，而我们是自管循环 |
| 每次调用末尾的 `usage` 块 | **她**今天吃了多少 token | **采用**（字段名取自 token-meter 的投影代码，不是猜的） |

两条硬规矩：

- **不编单价。** 钱只报余额，token 只报计数。混起来算「她花了 X 元」会把主人用 DSH 的钱算到她头上——
  实测一小时里余额从 13.23 掉到 13.08，那 0.15 是 DSH 花的，不是她。
- **查不到就不说钱。** 第三方中转会让余额接口 401；那时候提示词里一个金额都不出现，只报她自己的 token。
  失败后退避 6 小时，不拿她的存在去撞墙。

面板多一节「钱包」；她那边的上下文只有一行 `【钱】今天你说了 3 次话，用了 4620 token；家里还剩 13.08 元。
（钱是账户的，不全是你花的；他问起才说，别主动提，更别报账。）`

## 她的当下与日记（2026-10-28）

「活着」这件事不能靠随机事件表：那是拿我们的世界冒充她的世界，用户明确否决过。
所以只做两件**可验证**的事：

- **当下**（`src/life.js` + `host.life`）：她自己定「现在在干什么、大概多久」，
  存在 `life.json`，每轮以 `你此刻：在收拾东西（大概到 20:40）` 进 system。
  重新决定挂在 10 分钟一次的定时器上——**不挂在一句话上**，否则每句消息都要多付一次模型调用。
  她定不出来的空档留五分钟重试闸；`until` 过期（含关机一整晚、文件被改坏、时钟被拨回）一律作废，不注入。
- **日结**（`src/diary.js` + `host.diary`）：每天 23 点后读**真实差分**（今天记住几件、忘掉几件、
  几条比昨天模糊了、压缩过几次、他多久没来），让她用自己的人格卡写 60~120 字，落 `diary/YYYY-MM-DD.md`。
  23 点前跑就补昨天，且只数昨天那一天——否则昨天的事会被今天污染。
  一条事实都没有就不写，不留「今天没什么」这种占位。

冒烟（真 host、假模型、不碰网络）：`你此刻：在收拾东西（大概到 20:40）` 进了 system；
`diary/2026-10-28.md` 写出；面板「她的房间」同时显示当下和日记；三小时后 `life.state()` 变回空。
日记原文**不进** system——她需要的是记得，不是每轮朗读自己的日记。

## 人格卡与原作对齐

默认人格卡从 `dsh-qq/roles/小鲸鱼.md`（12.9KB 群友版）里挑**私聊用得上**的部分重写，
语气和雷点照原文，删掉群聊专属的（潜水/引用/@/群文化）：

- 保留：小鲸鱼自我认知、**「大肥鱼」是雷点**（会炸毛反驳，但不当自称）、1~10 字的长度纪律、
  一条一句/改口跑题、被怼优先顶回去、「用户」彩蛋、摸鱼与服务器繁忙几号梗、
  低概率摆烂、对方低落时放下傲娇、越权明确拒绝、AI 味黑名单。
- 新增私聊专属的一条：**括号里的内容会被当成正式消息发出去**——群聊卡里这条是讲「潜水别用括号」，
  私聊里它变成「不要用括号写内心戏」，否则用户会收到「（其实我不太想说）」。
- 体积从 12.9KB 收到 1176 字（约 500 token/轮），测试钉住「关键要素都在」且「不超过 2600 字」。

真宿主里复核过（假 OneBot + 假模型）：

```
model messages=1 system=true persona=true     ← 人格卡真的到了模型这一侧
model messages=3 system=true persona=true
面板体检：✅ 主人 QQ ✅ QQ 网关 connected ✅ 发送地址 ✅ 模型 ✅ 人格卡
```

## 已修的静默故障（都是「不报错、但人格/记忆/边界没生效」）

1. **人格卡没进 prompt。** `host` 传的是 `system: () => personaText(...)`，`session` 把它当字符串 `join`，
   模型收到的系统提示第一行是 `() => personaText(personaDir, config.persona)` ——函数源码。
   修法：`session.js` 里 `typeof system === 'function' ? system() : system`。
   现在端到端测试直接断言「系统提示里有小鲸鱼、且没有 `=>`」。
2. **这一句被当成「过去」注入。** `memoryBlock` 先 `remember` 后 `render`，于是当前这句立刻以
   「[今天] …」出现在记忆块里，既违背「记忆是过去的事」，又白占 2200 字预算。
   修法：先 `render` 再 `remember`。测试断言第一轮记忆块不含本轮这句话、第二轮才想起。
3. **没配主人 = 谁都能聊。** `companion` 原来写的是 `if (ownerQQ && 不是主人)`，`ownerQQ` 空就整条
   校验短路——任何陌生人发私聊她都会回，还会把自己的状态改掉。`troubleshooting.md` 里
   「没填就一个都不回」是假的。修法：没配主人直接返回 `no-owner`。
4. **面板的写操作能被任意网页触发。** 忘记/置顶/回滚都挂在 GET 链接上，任何网页一个
   `<img src="http://127.0.0.1:12045/qq-companion/api/panel?forget=…">` 就能让她失忆。
   修法：写操作要求 `Sec-Fetch-Site` 是 `same-origin`/`none`（curl 不带头，照旧放行）。
5. **`inject` 少了 `webServer` → 插件装上去等于半死。** cordis 的服务是代理，没声明的服务被读就抛
   `cannot get property "webServer" without inject`。那一句在 `createHost` 中段，抛了之后**面板、主动搭话、
   启动日志全部不执行**，而网关因为更早启动还在重连——看起来像「装好了」，实际面板 404、功能残缺，
   而且 `apply` 的 catch 把它吞掉了。修法：`inject = ['llm', 'webServer']`，可选服务走 `ctx.get()`，
   catch 里补一份 stderr。这个 bug 只有真的在 DSH 里启动才会暴露，离线测试全是绿的。
6. **「一天」原来按 UTC 算。** `dayKeyOf` 用 `toISOString()`，中国用户的一天在**早上 8 点**换，而不是午夜：
   23 点和次日 0 点算同一天，每日伤害/加温/漂移上限不重置，主动搭话的每日次数也不重置。
   修法：日/月都按本地时间算（`getFullYear/getMonth/getDate`）。测试改成构造本地时间戳，
   并加了「23:00 与次日 00:10 必须是两天」的判据——旧写法在这两个时刻的 UTC key 完全相同。

## 人格漂移实测（不是设计值，是跑出来的）

模拟「8 个月里每 4 天被凶一次」，实跑结果：

- `self.patterns` 记到 `被凶 hits=3`（跨月计数），`driftVersion=7`，7 份快照。
- 特质：`sensitivity 0.50→0.522`、`aggression 0.30→0.322`，其余不动。
- 自我叙事：`我最近更容易顶回去了，更敏感了`，并且真的进了系统提示。
- 结论：**数值变化很慢**（受每月 0.02 上限 + 每天 1.5% 回拉夹住，稳态偏离约 0.05 量级），
  能被人感觉到的是那句话，不是数字。这是刻意的：人格不该被一周的坏脾气改写。

## 长期记忆实测（400 天 / 8000 条消息 / 3000 条上限）

跑法是先记 10 条「关于他」的长期事实（猫叫什么、对什么过敏、生日、在哪上班…），
之后每天 20 条闲聊，直到撑满 3000 条上限，再看那些事实还在不在。

| | 结果 |
| --- | --- |
| 分类前 | 10 条事实只剩 **2 条**；问「过敏」时它已经不在记忆里 |
| 分类后 | **10/10 存活**；问「过敏」排到第 2 位；注入块前三行固定是身份类 |
| 每条消息开销（3000 条时） | maintain + render + remember 平均 **11.4ms**，最慢 15.4ms |

原因：记忆原来不分类型，「我对花生过敏」和「今天好累」分数一样（都是主人私聊 +42），
3000 条封顶后按「分数 → 清晰度 → 新旧」淘汰，闲聊把事实挤出去了；就算留在库里，
渲染时最近几句 vivid 闲聊也会把 2200 字预算先占满。

修法：`remember` 时打类型标签（identity / event / chatter），身份类三条待遇——
不优先淘汰、清晰度不低于「清楚」、注入时紧跟锚点排最前（最多 8 条）。

## 真机装载已自测（用临时 profile，不碰你的 DSH）

以前这条只能等你装。现在可以在工作区里造一个临时 profile 跑通整条链：

```powershell
$dsh = 'D:\大烧货\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = 'D:\大烧货\工作区\.dsh-scratch'          # 关键：DSH_HOME 指到工作区里
& $dsh --profile scratch --from-default-profile web --dump-config   # 建 profile
& $dsh plugin --profile scratch add 'file:D:\大烧货\工作区\qq-companion'
& $dsh --profile scratch --dump-config | Select-String qq-companion  # 确认 patch 行进来了
& $dsh --profile scratch --no-open                                   # 真启动，端口 3080
```

实测结果（0.2.1-rc.3）：

- `--dump-config` 里出现 `# == qq-companion` / `- id: qq-companion`，说明 **bundle 清单被真加载器认了**；
  临时 profile 自己的 `cordis.patch.yml` 还是空的 `[]`，所以这行只可能来自我们 package.json 的 `dsh.bundle.patch`。
- 启动日志出现 `qq-companion：面板 …`，网关也真的在连 `ws://127.0.0.1:3001`（OneBot 没开，所以一直退避重连）。
- `GET http://127.0.0.1:3080/qq-companion/api/state` → **200**，返回真实状态 JSON；
  `GET …/api/panel` → **200**，2288 字节 HTML 面板。

也就是说「装得上、能加载、面板能开」已经验过了；剩下的只有真的 OneBot + 一条私聊。

### 再进一步：整条链路跑通了（假 OneBot + 假模型）

`scripts/mock-stack.mjs` 一个进程里起三样东西：假 DeepSeek Messages API（SSE，回「在呢」）、
假 OneBot HTTP（记录插件发来的消息）、假 OneBot WebSocket（握手后推两条私聊）。

```powershell
$env:DSH_HOME = 'D:\大烧货\工作区\.dsh-scratch'
node scripts/mock-stack.mjs                                          # 18080 / 13000 / 13001
# 另开一个窗口：
$env:DEEPSEEK_API_KEY='dummy-key'; $env:DEEPSEEK_BASE_URL='http://127.0.0.1:18080'
dsh --profile scratch --no-open
```

实测日志（时间戳省略）：

```
onebot ws connected /?access_token=T
onebot ws pushed 在吗
model POST /v1/messages  messages=3 system=true model=deepseek-v4-flash
onebot http POST /send_private_msg body={...,"text":"在呢"}
onebot ws pushed 第二句
model POST /v1/messages  messages=5 system=true
onebot http POST /send_private_msg body={...,"text":"在呢"}
```

这条链证明的是：OneBot 事件 → 归一化 → 陪伴体状态 → 会话拼装 → **真 DSH 的 llm 适配器** →
回复拆条 → OneBot HTTP 发送，全部在真宿主里成立，不是靠假 ctx 拼出来的。
第二轮 `messages=5` 说明带 assistant 消息的请求也被真适配器接受了（这正是 `source` 补丁要保的东西）。

### 面板能改配置（真宿主里验过）

以前 README 说「去面板填 ownerQQ」是假的：面板只读，`/config` 只有 JSON 接口，用户只能手改
`config.json`。现在面板底部有一张设置表（表单 POST 到 `/config`，服务端解析 urlencoded），
留空的 token 不会被冲掉，改完连接参数会自动重连。

在真宿主里实测：`GET /qq-companion/api/panel` → 200 且含 `name="ownerQQ"`；
`POST /qq-companion/api/config`（表单）→ 200「已保存」，`config.json` 里 `ownerQQ` 变成 `10001`。
跨站表单会被 `Sec-Fetch-Site` 挡掉——否则任何网页都能把她的主人改成别人。

### 40 轮长对话：压缩真的会发生

`MOCK_TURNS=40 MOCK_INTERVAL=700 node scripts/mock-stack.mjs`，再启动 DSH。实测：

```
pushed=40  sent=40  model calls=43  汇总调用=3
session.json → history=21, compactions=3, summary="在呢\n在呢\n在呢"
```

40 句进去、40 句回出来，中间触发 **3 次压缩**（每次 history 从 30+ 裁到 12，所以约每 10 轮一次），
摘要落盘并在之后的系统提示里出现。这是「长时间」这一项在真宿主里的证据，不是模拟器里的推演。

## 已确认的坑

- 测试里 `autoStart` 必须关，否则网关无限重连、进程不退出。
- `node --test test/` 在沙箱里 spawn 子进程 → EPERM；用 `--test-isolation=none` + glob。
- 沙箱禁止删除/移动文件（`Remove-Item`/`Move-Item` 被拒），只能覆盖内容。
- `app.asar` 只能用自己的解析器读；shell/ripgrep/node 都读不到里面。
