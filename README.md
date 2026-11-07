# qq-companion

DSH 插件：**只服务一个人的 QQ 私聊陪伴体**。

> **关于这个仓库**
> 2026-11-03 17:52，工作区目录在一次 DSH 重启中被清空，源码连同原有的 git 历史一起丢失。
> 现在的这份代码是**从 DSH 的会话日志里逐条重放 `write` / `edit` 恢复出来的**（87 个文件），
> 又手工修掉了重放对不齐造成的重复代码块。因此：
>
> - 提交历史从 2026-11-04 开始，之前那 22 个提交无法恢复；
> - 恢复后有 4 个测试（原 290 → 现 286）因为当时是直接用 PowerShell 改的、没有进日志，暂时缺失；
> - 现在 `node --test --test-isolation=none "test/*.test.mjs"` 是 **286 通过 / 0 失败**。

- 有自己的情绪（效价/唤醒/强度），会按半衰期回落
- 有会变的人格（五特质，月更、限幅、可回滚）
- 有关系（信任/亲密/戒备/亏欠，惰性结算）
- 有一张**会遗忘的记忆卡**：四档清晰度、每天最多降一档、停机按天补跑；
  初次相遇、置顶、主人重要记忆永不遗忘；想起旧事时会带出**当时的感受**（「那会儿我挺难受」）；
  **遗忘是可逆的**——软删除保留 90 天，面板上点一下就找回来
- 会话历史自己管，超阈值压成摘要；压缩失败不丢历史
- 有她自己的一天：此刻在干什么、昨天写了什么日记、刚才关机的那几个小时她「不在」
- 有钱：账户余额查真的，她自己的 token 自己数（不编单价）
- **看得懂你发的东西**：图、表情包、动图（抽 4 帧看动作）；引用能查到原句；看不到就直说，不编
- **她自己的 QQ 空间**：有值得说的事才发，能读评论、能回、能删

**人格与记忆的完整架构（四层时间尺度、记忆卡判定链、每轮注入顺序、被否决的方案）：
[docs/architecture.md](docs/architecture.md)**

## 安装

DSH 侧栏 **Plugins → Add plugin**，填这个目录的绝对路径：

```
D:\大烧货\工作区\qq-companion
```

装完重启 DSH；设置/插件页里应出现「QQ 陪伴体」。

- 生产版 Desktop 走 `file:` 复制安装：**改代码后要重新安装**才生效。
- 开发版 Desktop / Source Web 可以用 `link:<绝对路径>`，改完重启即可。
- 不要手改 profile 的 `package.json` / `cordis.patch.yml`，也不要自己在 profile 里跑 pnpm——
  官方 `cordis-plugin-development` skill 明确禁止，且每次手写都要单独授权。

## 配置

**最省事的方式：面板里填。** 装好后打开 `http://127.0.0.1:12045/qq-companion/api/panel`
（端口以你的 DSH 为准；启动日志会把完整地址打出来），最下面「设置」那张表能改
`ownerQQ` / OneBot 两个地址 / token / 人格名，保存即生效：连接参数变了会自动重连。
token 那一格留空表示「不改」。

也可以直接改 `%USERPROFILE%\.dsh\plugins-data\qq-companion\config.json`（首次启动自动生成）：

```jsonc
{
  "enabled": true,
  "ownerQQ": "你的QQ号",              // 只服务这个人
  "onebot": {
    "httpUrl": "http://127.0.0.1:3001",
    "wsUrl": "ws://127.0.0.1:3001",
    "token": "SnowLuma 的 access token"
  },
  "model": { "provider": "", "model": "" },   // 留空 = 用 DSH 的第一个 provider/model
  "persona": "小鲸鱼",
  "session": { "compactAt": 30, "keepRecent": 12, "replyDelayMs": 800 },
  "budget": { "lowBalance": 5 },             // 余额低于这个数，她才会主动提钱
  "proactive": {
    "enabled": true,         // 关掉她就一次都不会先开口
    "minIdleMinutes": 180,   // 他至少这么久没说话，才轮到她惦记
    "maxPerDay": 3,
    "minGapMinutes": 120,
    "maxConsecutive": 2,     // 他还没回，最多连发几条
    "quietFrom": 23,         // 安静时段，跨零点也认
    "quietTo": 8,
    "moodFloor": 0.25        // 心情低于这个值就不主动
  },
  "weather": {
    "enabled": true,         // 开着会连 Open-Meteo（免密钥）
    "place": "huzhou"        // huzhou（湖州师范大学）或 zhuji（诸暨）
  },
  "search": {
    "enabled": true,
    "key": "tvly-...",       // Tavily 的 key；留空就查不了，天气不受影响
    "maxPerDay": 5
  }
}
```

`replyDelayMs` 是**基础**思考延迟：心情好会更快（最低约 0.6 倍），心情差或戒备高会更慢（最高 2.6 倍，且不超过 15 秒）；
心情差时一次只发一条，被戳到时不追加。

人格卡：`plugins-data/qq-companion/personas/<名字>.md`，默认写入一份「小鲸鱼」私聊版。
改完下一轮生效，不用重启。

## 装好之后先自检

```bash
node scripts/preflight.mjs             # 配置/owner/地址/人格/数据
node scripts/preflight.mjs --install   # DSH 是否真的会加载这个 bundle（四处证据）
node scripts/preflight.mjs --online    # 真连一次 OneBot（只 get_login_info，不发消息）
```

哪一项 ❌ 就修哪一项。装不上/不生效的错误语义见 [docs/troubleshooting.md](docs/troubleshooting.md)。

**她不理你的时候，先看面板最上面的「体检」**：主人 QQ / QQ 网关 / 发送地址 / 模型 / 人格卡
五项逐条 ✅❌，红的那一行就是原因，不用翻日志。

## 数据

```
%USERPROFILE%\.dsh\plugins-data\qq-companion\
  config.json          配置
  affect.json          四层状态（+ .bak）
  memory.json          记忆卡（+ .bak）
  session.json         对话历史与摘要（重启接着聊）
  life.json            她此刻在做什么、到几点
  alive.json           上次醒着的时间戳
  budget.json          今天的 token 与账户余额
  diary-snapshot.json  昨天收摊时的记忆指纹（日记差分的基线）
  proactive.json       期待时间、今天主动了几次、上次想过什么
  weather.json         外面的天气（半小时一次，实测值）
  facts.json           她查过的事 + 来源（一天内算新鲜）
  diary/*.md           她自己写的日记
  personas/*.md        人格卡
```

## 面板接口

- `/qq-companion/api/panel` —— **只读自检页**（HTML，每 10 秒刷新）：此刻状态、人格与待结算模式、记忆卡分布、
  最近想起了什么、网关/会话。所有记忆文本都转义。页面上可以直接：回滚人格快照、置顶/取消置顶一条记忆、忘记一条记忆。
- `/qq-companion/api/state` —— 同一份数据的 JSON
- `/qq-companion/api/persona` —— GET 列表 / POST 保存人格
- `/qq-companion/api/config` —— GET / POST 配置

## 测试

```bash
npm test     # 358 项离线测试（无网络、无真 QQ）
```

## 状态

**已做**：私聊收发、情绪（效价/唤醒/强度 + 衰减 + 影响节奏与条数）、关系（信任/亲密/戒备/亏欠，
挨骂会掉、被认真对待会涨、忘了不等于原谅）、人格（五特质、月度结算、快照回滚、自我叙事）、
记忆卡（四档清晰度、每天一档、停机补跑、锚点不忘、BM25 召回、2200 字注入上限、遗忘可找回）、
主动搭话（期待时间 + 连发上限，扛过护栏才自己想一次发不发）、自检面板与安装体检、
**她知道自己几点、外面什么天**（Open-Meteo 实测，不是网页转述）、
**她想查点真事就能查**（Tavily，带来源，压成一句中文再记）、
**她自己的生活**（当下、日记、开机后知道自己不在过多久）、**钱包**（真余额 + 自己的 token）。

**未做**：群聊、语音、多对象、工具调用（联网搜索）。

**已验证**：bundle 能装进 DSH、插件真的加载、面板与接口在真宿主里 200、40 轮长对话会触发压缩、
以及用假 OneBot + 假模型跑通「QQ 事件 → 模型 → 回复发出」的完整链路。

**未验证**：真的 SnowLuma 与真的模型 key。装之前 `preflight --install` 会告诉你差哪一步。

逐条对照目标的验收报告（含复现命令）：[docs/acceptance.md](docs/acceptance.md)。


## 许可

本项目自己写的部分是 **MIT**，见 [LICENSE](LICENSE)。

借过谁的东西、用到什么程度、各自的许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
其中 SnowLuma 是「源码可见、非商业」许可（不是 OSI 开源），所以这里**只通过它的接口通信，不含它的任何代码**。

