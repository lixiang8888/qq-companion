# 游戏平台化 + 接入开源小游戏（2026-11-26）

状态：**已实现（2026-11-26）**，离线测试 813 项全过，四款游戏真机冒烟通过。

## 为什么要做

现在的游戏模块只有一款写死的《植物大战僵尸》复刻版：`src/game.js` 里是它的关卡和数值，
`src/host.js` 的 `runGame` 里是它的暂停/收阳光/种植流程，`game.json` 的形状也是它的战绩。
她说「我最近在打僵尸」是真的，但「游戏」这件事本身不是可扩展的——第二款游戏接不进来，
以后「她自己找游戏玩」也就无从谈起。

用户这一轮定的方向（2026-11-26）：

1. **平台化 + 接入 GitHub 上一些简单开源小游戏**（先不让她自主下载）；
2. 玩法：**结构化优先，看屏兜底**；
3. 边界：**只浏览器游戏**——HTML/JS 在隔离的无头浏览器里跑，不装 exe、不碰系统目录。

## 做法

### 1. 游戏包

每款游戏一个目录，一份清单，页面代码原样（或只做注明的最小改动）：

```
assets/games/
  i18n.js                     # mashukui/web-games 共享脚本（关掉统计，其余原样）
  pvz/index.html + game.json  # 从 assets/pvz 原样搬过来
  g2048/...   + game.json     # gabrielecirulli/2048（MIT）
  sokoban/index.html + game.json
  lightsout/index.html + game.json
```

`game.json` 约定：

```json
{
  "id": "g2048",
  "title": "2048",
  "kind": "structured",        // structured | vision
  "entry": "g2048/index.html", // 相对 assets/games/
  "ready": "document.querySelector('.tile-container') !== null",  // 可选：页面就绪判据
  "summary": "一句话说这是什么游戏",
  "controls": "方向键：上/下/左/右",
  "license": "MIT",
  "source": "https://github.com/..."
}
```

vision 游戏额外带 `start` / `done` 两条页面表达式（点开始、判胜负）。
结构化游戏的驱动是代码，`src/games/<id>.js` 导出驱动规格；目录扫描时只认有驱动的 structured 包。

### 2. 无头浏览器 + 本地静态服务

`src/games/browser.js`：从 `src/pvz.js` 抽出通用层。

- `startStaticServer({ root })`：127.0.0.1 随机端口，只读 `root` 下的文件。
  用 http 而不是 file://：localStorage、相对路径、字体都跟真页面一致。
- `createBrowser({ bin, root })`：起无头 Edge/Chrome、连 CDP；
  `open(entry, { ready })`、`evaluate`、`screenshot`、`click(x,y)`、`key(name)`、`close()`。
- 浏览器进程和临时 profile 一定要关；Windows 上 taskkill /T。

### 3. 一局怎么跑

`src/games/turnbased.js`（结构化，也是「优先」那条路）：

```
准备 → [收阳光/暂停] → 读状态 → 她决定 → 落一手 → 等一会 → 再暂停
```

驱动规格只写「这款游戏特有的事」：

```js
{
  id, title,
  stepMs, maxDecisions,
  prepare({ browser, progress }),      // 开波数、点开始、设语言、跳关
  beforeTurn({ browser }),             // 例如收阳光
  pause({ browser, on }),              // 只有实时游戏需要
  read({ browser }) -> state,          // 读真实状态
  board(state) -> string,              // 给她看的文字棋盘
  prompt({ state, board, progress }) -> { instructions, user, maxTokens },
  parse(reply) -> action,              // {kind:'move'|'wait'|'quit'|...}
  apply({ browser, action, progress }) -> { ok, note },
  done(state) -> { over, victory, reason },
  finish({ state, progress, notes, sessions }) -> { facts, progress: nextProgress },
}
```

`src/games/vision.js`（看屏兜底）：截图 → deepseek-flash 看图并给动作 JSON
（`click`/`key`/`wait`/`quit`）→ CDP 执行 → 记下每一步的 `look` 文字和动作。
事后她只拿「玩了多久、动了几次、她当时看到/说了什么」当材料；截图在本次会话里留着可复核。

### 4. 战绩与注入

`src/games/records.js`：`game.json` 新形状。

```json
{
  "at": 0, "day": "", "plays": 0,
  "last": { "game": "g2048", "title": "2048", "facts": "…", "victory": false, "quit": false,
            "thought": "…", "label": "爽", "intensity": 2, "anchor": "…", "at": 0 },
  "recent": [],
  "library": {
    "pvz": { "level": 2, "cleared": [1], "top": {}, "at": … },
    "g2048": { "best": 1024, "plays": 3, "at": … }
  }
}
```

旧的 `game.json` 在读取时迁移：原来的关卡/最好成绩就是 `library.pvz`，原来的 `last` 变成通用 `last`。
`gameLine` / 面板 / 感知 / 意图层都改成读通用 `last` + `library`（PvZ 的关卡目标仍读 `library.pvz.cleared`）。

### 5. 她玩哪一款

- 她心里有「想玩某个游戏」的未完成念头（`do` 循环的 `target.game`）→ 先玩那款；
- 否则把能玩的几款和各自上次战绩给她看一眼，让她自己挑；挑不出来就按最久没玩的轮换；
- 只剩看屏游戏且拿不到看图密钥时，跳过（记日志，不编）。

## 验收

- `npm test` 全绿（现有 786 条加上新测试）。
- 真机冒烟（`.tmp/` 脚本，不进仓库）：无头浏览器里四款游戏都能打开、能读状态、能落一手、
  状态真的变了；Lights Out 能截图、能点、点完局面变了。
- 已在跑的那一局 PvZ 行为不变：关卡、暂停、收阳光、解锁植物、局后感想、记忆卡、意图层仍然对。
- 面板能看出「最近在玩哪款、玩过几款」。
- 文档：THIRD_PARTY_NOTICES（两款上游、许可、改动）、README、design/02、TODO。

## 不做（这轮）

- 自主下载游戏（DSH 采购 agent）——等这一层在真机上跑顺了再上。
- 单机 exe / 安装包。
- 每款游戏单独的技能/攻略知识；她玩得笨就是玩得笨。

## 实现记录（2026-11-26）

实际落地与上面计划的差异，都是实现时发现的：

1. **本地静态服务不是可选项**：`file://` 下 2048 的 localStorage 会抛，推箱子的 i18n 也要正常相对路径。
   改成每次开局起一个只绑 `127.0.0.1` 的只读静态服务（`src/games/browser.js`），游戏页面走 http。
2. **2048 没改它的代码**：它每走一步都把整盘写进 localStorage 的 `gameState`，直接读那份存档；
   操作走 CDP 真键盘（它监听 `keydown.which`，合成事件的 which 对不上）。
3. **推箱子用上游自带的只读探针**：`window.__st()` 读关卡/步数/箱子计数，棋盘按 DOM class 还原成标准字符画。
4. **点灯是看屏兜底的第一款**：没有结构化接口；`assets/games/lightsout/game.json` 提供开始/结束两条页面表达式，
   `src/games/vision.js` 负责截图、看图给动作、执行、记录。看图凭据复用 `credentials.resolve('DEEPSEEK_API_KEY')`。
5. **i18n.js 改了一处**：上游的 GoatCounter 地址置空，不发统计请求（见 THIRD_PARTY_NOTICES）。
6. **`game.json` 旧数据自动迁移**：根上的 level/cleared/top 变成 `library.pvz`，旧 `last` 变成通用一条；
   读取时迁移、下一次落盘变新形状。
7. **`config.game.stepMs` 只影响 PvZ**（旧语义），其它游戏用自己驱动里的默认节奏；`config.game.vision` 给看屏兜底用。
8. 文件：`src/games/{browser,catalog,records,pick,turnbased,vision,drivers}.js` +
   `src/games/{pvz,g2048,sokoban}.js`；`src/pvz.js` 删除；`assets/pvz/` 移到 `assets/games/pvz/`。
   测试新增 `test/games-*.test.mjs`，重写 `test/game-host.test.mjs`。
9. 真机冒烟脚本在 `.tmp/smoke-games.mjs`（不进仓库）：四款游戏都能打开、读状态、落一手、点灯能截图并真点。


