# 第三方声明

这个项目自己写的部分是 MIT（见 [LICENSE](LICENSE)）。下面这些是**借鉴或衍生**过来的东西，按各自的许可留名。

> 这不是法律意见，只是把"我用过谁的东西"写清楚。自用项目，留个名是底线。

## 代码层面动过的

| 项目 | 许可 | 用在哪 | 程度 |
|---|---|---|---|
| [SurfCore](https://github.com/Mieksido/surfcore) | MIT | `src/memory/card.js` 的记忆卡设计（四档清晰度、锚点、重要度打分） | 按其 `MEMORY_CARD.md` 写了最小实现，**代码是自己写的**，结构和规则来自它 |
| dsh-memory-core | MIT | `src/memory/sanitize.js` 的脱敏模式；`src/session.js` 的「记忆使用协议」五条 | 模式与条文取自它，实现改写 |
| [dsh-qq-zone](https://github.com/LFELKEEA/dsh-qq-zone) | MIT | `src/qzone.js` 的错误分类（unreachable / unauthorized / action-missing / rejected） | 分类思路，代码自己写；接口形状是在 SnowLuma 上实测的 |

## 运行时依赖

| 依赖 | 许可 | 用在哪 |
|---|---|---|
| [sharp](https://sharp.pixelplumbing.com/) | Apache-2.0 | 动图抽帧（GIF / 动态 WebP 解码成多帧）；视频帧的缩放、变化分取样、拼图合成。只做图像解码与合成，不碰别的 |

`node_modules/` 不进仓库，换机器要重新 `npm install`。

### Plants vs Zombies 复刻版（2026-11-22，她自己的小游戏）

- 项目：plantsvszombiesjs/plantsvszombiesjs.github.io（https://github.com/plantsvszombiesjs/plantsvszombiesjs.github.io）
- 许可：MIT，© 2025 Valentyn Kolesnikov；原文随文件放在 ssets/pvz/LICENSE
- 用法：**整份单文件页面原样放进来**（ssets/pvz/index.html，81 KB，无依赖），由宿主用无头浏览器打开，
  她那几手指令是通过页面自己暴露的 gameState / selectPlant / placePlant 执行的。没有改动其代码。
- 没有采用 EA 原版《植物大战僵尸》的任何东西（素材、音乐、关卡数据都没有）；
  这个复刻的数值和美术是它自己的，跟原版不一样，别混着说。
## 只调用接口、未复制代码的

| 项目 | 许可 | 关系 |
|---|---|---|
| [Legado / 阅读 3.0](https://github.com/gedoor/legado) | 原 GPL-3.0（仓库现在已无 LICENSE 可核，见下） | 她读书的后端。**仓库里不含它的任何代码或 APK**：它是装在安卓模拟器里的独立 App，我们只调它自带的本地 Web 服务（`/getBookshelf`、`/getChapterList`、`/getBookContent`），不链接、不打包、不分发 |
| [ApkStart](https://github.com/RoutineMiku/apkstart) | MIT | 让 Legado 跑起来的安卓应用运行器（Windows 上的 QEMU + Android 14）。**只当外部程序用**：下的是官方轻量便携版，只改过它的 `settings.json`（关自启/预启、清空 device），没改一行代码；仓库里不含它的代码或二进制 |
| [SnowLuma](https://github.com/SnowLuma/SnowLuma) | **源码可见、非商业**（不是 OSI 开源） | 只通过它的 HTTP / WebSocket 接口通信，**仓库里不含它的任何代码或二进制**。这条不能破：它的许可与 MIT 不兼容 |
| [NapCat](https://github.com/NapNeko/NapCatQQ) | 见其仓库 | 动作名（`send_qzone_msg` 等）和参数形状属于接口事实，代码未复制 |
| [Open-Meteo](https://open-meteo.com/) | CC BY 4.0（数据）/ 免密钥接口 | 只按 HTTP 公开接口取天气观测值，不含其代码。免费额度前提是非商业用途 |
| [Tavily](https://tavily.com/) | 商业接口，按账号条款 | 只调 `/search` 接口；key 存在本机 `config.json`，不进仓库 |
| [ffmpeg](https://ffmpeg.org/) | gyan.dev 的 essentials 构建是 **GPLv3** | `src/video.js` 只把它当**外部程序**用 `spawn` 调（抽帧），不链接、不打包。**仓库里不含它的二进制**——需要时自己下到 `<数据目录>/bin/ffmpeg.exe` |

### ApkStart 的许可链（它自己 MIT，但运行时是别人的）

ApkStart 本体是 **MIT**（Copyright (c) 2026 ApkStart contributors）。它拉起来的运行时不是它的：

| 运行时组件 | 许可 | 说明 |
|---|---|---|
| Android Emulator（QEMU） | **GPL-2.0** | 由 ApkStart 下载 / 打包，我们只是运行，**不重分发** |
| Android 系统镜像（API 34） | Google 的 SDK/系统镜像条款，**不可再分发** | 同上，本机运行 |
| adb / platform-tools | Apache-2.0 | 同上 |

所以我们这边的边界只有一句话：**不把 ApkStart、模拟器、系统镜像放到任何仓库或分发物里**。
换台机器要自己下（轻量便携版 96 MiB + 首次启动下运行时），这也正是我们现在的做法。

### Legado 的特殊情况（2026-11-18 核对）

`gedoor/legado` 原为 **GPL-3.0** 的安卓阅读器（约 47.2k star）。现在**上游已被作者清空**：
仓库里只剩一页公告和一张图（`pushed_at` = 2026-05-27），公告承认侵权、承担法律责任并删除全部内容；
公开报道称两位开发者因**侵犯著作权罪**被判有期徒刑二年 / 一年九个月并处罚金，涉侵权作品近 4000 部
（[小众软件报道](https://www.appinn.com/xxdu-app-developers-jailed-for-copyright-infringement/)）。
所以 GPL-3.0 只能按历史说法记，**仓库里已经没有可核对的 LICENSE 文件**。

这不改变我们的用法（不打包、不分发、只调本地接口），但改变**风险的性质**：
书源（顶点小说 / 玄幻阁 / 笔趣阁这类）抓的是盗版站，**自用也有著作权风险**，
而且这条风险不是版权纠纷，是刑事案例。自用、不传播、不售卖是我们这边的底线；要不要继续用，是使用者的选择。

## 只读过思路的

下面这些只读了 README / 设计说明，**没有复制代码**，详细判断记在 [docs/references.md](docs/references.md)。

### 2026-11 这一批（主动搭话 / 天气 / 看视频）

| 项目 | 许可 | 借了什么 | 落在哪 |
|---|---|---|---|
| [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) | **Apache-2.0** | 两条核心：①**先判断这一帧值不值得看**再决定传不传（0–255 变化分，64×36 网格）；②留下来的几帧**拼进同一张图**——一张里塞 4 帧还是 8 帧价格差不多。另外它算的账我们也照用了：宽度对齐 **42px** patch 网格（800 会被 pad 到 812，白算一整列，798 正好 19 列） | [src/video.js](qq-companion/src/video.js)。**只借思路，没有沿用它的抓屏管线、没有引入它的依赖** |
| [dsh-heartbeat-inner](https://github.com/zy666946/dsh-heartbeat-inner) | MIT | 「期待时间」代替固定间隔；`{send, waitMinutes}` 的决策 JSON；发了没回的退避 | [src/proactive.js](qq-companion/src/proactive.js) |
| [dsh-proactive](https://github.com/john-walks-slow/dsh-proactive) | MIT | 「唤醒不等于发言」——静默轮次不该留下来污染长期上下文 | 同上（「想」不写进主历史） |
| [Kanadego/dsh-heartbeat](https://github.com/Kanadego/dsh-heartbeat) | MIT | 「闸门先于模型」：判别说时根本不调模型，省 token 也避免硬凑话 | 同上（`pokeGate` 先于那次调用） |
| [dsh-environment-context](https://github.com/liqiming-whu/dsh-environment-context) | MIT | 天气源的容错顺序（Open-Meteo → MET Norway → wttr.in）、以及「环境用系统提示段注入，不产生聊天消息」这条做法 | [src/weather.js](qq-companion/src/weather.js)（我们只用了第一路，因为它是实测值） |

### 只看过、**没有采用**的

2026-11 查「能不能让她刷 B站」时读了这四个。结论是它们都是**给 DSH agent 的工具插件**，
而本项目的对话循环是自建的、没有工具面，所以一个都没装、也没抄：

[c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)、
[pyyxzi/dsh-deepmoyu](https://github.com/pyyxzi/dsh-deepmoyu)、
[QiuYeDx/dsh-bili-eyes](https://github.com/QiuYeDx/dsh-bili-eyes)、
[tuanzhanghao/dsh-bili-mini](https://github.com/tuanzhanghao/dsh-bili-mini)（均 MIT）。

### 更早读过的那批

dsh-plugin-soul、dsh-persona-memory、dsh-character-presets、dsh-companion、dsh-memory-core、
灵枢 lingshu-skill、agent-memory-experiment、deepseek-harness-digital-life、astrbot_plugin_qzone_bridge、
astrbot_plugin_private_companion、internetsb/Maizone、dsh-soul-evolve。

其中 `docs/design/affection_audit.md` 是别人写的好感度审计报告，当作参考阅读，未复制其代码。

## 顺带说清楚的两件事

- **商标**：仓库名里带 `QQ`，人格卡自称「DeepSeek 小鲸鱼」。自用没问题，**发布或商用是另一回事**。
- **账号风险**：用 OneBot / 第三方协议端登录个人 QQ 本身不符合 QQ 用户协议。代价不是版权纠纷，是封号。


