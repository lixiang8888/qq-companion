# 真机验证：装完之后的 10 分钟

> 每一步都写清「应该看到什么」和「没看到时看哪里」。

## 0. 装

DSH 侧栏 **Plugins → Add plugin** → 绝对路径 `D:\大烧货\工作区\qq-companion` → 重启 DSH。

然后：

```bash
node scripts/preflight.mjs --install
```

期望：四处证据全 ✅。有 ❌ 就按 [troubleshooting.md](troubleshooting.md) 那张表修。

## 1. 插件活着吗

```bash
node scripts/verify-live.mjs
```

预期输出里应有：

```
✅ 插件接口 http://127.0.0.1:12045/qq-companion/api/state
   网关 stopped · 会话 0 轮 · 记忆 0 条 · 人格 小鲸鱼
```

- `HTTP 404` → 插件没加载（回去看 `--install`）
- `ECONNREFUSED` → DSH 端口不对，加 `--port <端口>`
- `网关 stopped` → 正常，还没连 QQ；下一步填配置

## 2. 配上 QQ

**推荐：面板里填。** 打开 `http://127.0.0.1:12045/qq-companion/api/panel`，拉到最下面「设置」，
填 ownerQQ、OneBot 两个地址、token，保存即生效（连接参数变了会自动重连）。
面板最上面的「体检」五项全绿，就说明配置这关过了。

也可以直接改 `%USERPROFILE%\.dsh\plugins-data\qq-companion\config.json`：

```jsonc
{
  "ownerQQ": "你的QQ号",
  "onebot": { "httpUrl": "http://127.0.0.1:3000", "wsUrl": "ws://127.0.0.1:3001", "token": "SnowLuma 的 token" }
}
```

改完再跑：

```bash
node scripts/preflight.mjs --online     # 只调 get_login_info
node scripts/verify-live.mjs            # 网关应从 stopped 变 connected
```

> 注意：`httpUrl` 与 `wsUrl` 在 SnowLuma 里**可能是两个不同的端口**，不要照着这里抄。

## 3. 发一条私聊

用 `ownerQQ` 那个号给机器人发一句「在吗」。

| 应该看到 | 没看到时看 |
| --- | --- |
| 1~2 条回复，间隔约 1 秒 | `verify-live` 的网关状态；`/api/state` 的 `session.size` 有没有涨 |
| 面板 `会话 N 轮` 增加 | 面板 `/qq-companion/api/panel` |
| 面板「最近想起」出现这一轮 | 说明检索没命中（正常，记忆还空） |
| 记忆条数 +1 | 说明写入失败，看宿主日志里的 `qq-companion` |

回复慢是正常的：默认每条前等 800ms（`session.replyDelayMs`），心情差会更慢。

## 4. 重启 DSH

再跑 `verify-live`：`会话 N 轮` 应该还在（历史落盘了），`记忆 N 条` 也应该还在。

如果会话归零：看 `plugins-data/qq-companion/session.json` 是否生成、是否写在别的 `DSH_HOME` 下。

## 5. 隔一天再看

- `memory.json` 里应该有 `clarity` 从 `vivid` 往 `clear` 走的记录（每天最多降一档）
- 面板「人格」区应出现「待结算的模式」（被夸/被凶/低落 的计数）
- 一个月后若同一模式 ≥5 次且跨 ≥3 天，会看到「快照 1 版」和一句自我叙事

## 出问题时的三个地方

1. `node scripts/preflight.mjs --install --online`：清单 + 连通
2. `/qq-companion/api/panel`：状态、网关、记忆、最近想起
3. 宿主日志（搜 `qq-companion`）：启动失败、模型错误码、发送失败
