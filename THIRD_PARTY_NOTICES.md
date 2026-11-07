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
| [sharp](https://sharp.pixelplumbing.com/) | Apache-2.0 | 动图抽帧（GIF / 动态 WebP 解码成多帧）。只做解码，不碰别的 |

`node_modules/` 不进仓库，换机器要重新 `npm install`。
## 只调用接口、未复制代码的

| 项目 | 许可 | 关系 |
|---|---|---|
| [SnowLuma](https://github.com/SnowLuma/SnowLuma) | **源码可见、非商业**（不是 OSI 开源） | 只通过它的 HTTP / WebSocket 接口通信，**仓库里不含它的任何代码或二进制**。这条不能破：它的许可与 MIT 不兼容 |
| [NapCat](https://github.com/NapNeko/NapCatQQ) | 见其仓库 | 动作名（`send_qzone_msg` 等）和参数形状属于接口事实，代码未复制 |

## 只读过思路的

下面这些只读了 README / 文档，没有复制代码，出处记在 [docs/references.md](docs/references.md)：

dsh-plugin-soul、dsh-persona-memory、dsh-character-presets、dsh-companion、dsh-memory-core、
灵枢 lingshu-skill、agent-memory-experiment、deepseek-harness-digital-life、astrbot_plugin_qzone_bridge、
astrbot_plugin_private_companion、internetsb/Maizone、dsh-soul-evolve。

其中 `docs/design/affection_audit.md` 是别人写的好感度审计报告，当作参考阅读，未复制其代码。

## 顺带说清楚的两件事

- **商标**：仓库名里带 `QQ`，人格卡自称「DeepSeek 小鲸鱼」。自用没问题，**发布或商用是另一回事**。
- **账号风险**：用 OneBot / 第三方协议端登录个人 QQ 本身不符合 QQ 用户协议。代价不是版权纠纷，是封号。

