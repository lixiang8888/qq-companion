# 装不上 / 装上了不生效：按错误语义查

> 依据 `dsh-plugin-manager` 与 `cordis-plugin-development` 的公开文档（0.2.1-rc.3）。

## 先跑自检

```bash
node scripts/preflight.mjs --install     # DSH 会不会加载它
node scripts/preflight.mjs --online      # OneBot 通不通（只读）
```

`--install` 看四处证据，缺一不可：

| 证据 | 位置 | 缺了会怎样 |
| --- | --- | --- |
| 依赖已声明 | profile `package.json` → `dependencies` | 包不在，装了个空 |
| bundle 已选择 | profile `package.json` → `dsh.profile.bundles` | **装上了但不会加载** |
| patch 行 | profile `cordis.patch.yml` | 加载了但没有插件行，等于没装 |
| 包实体 | profile `node_modules/qq-companion` | 依赖写了但没装上文件 |

## `install_bundle` 的返回怎么读

| 返回 | 含义 | 怎么办 |
| --- | --- | --- |
| `application: applied` | 已生效（可能在 HMR 后） | 去面板确认出现「QQ 陪伴体」 |
| `restart-required` | 替换了已加载的包 | 重启 DSH。**这是装的第二份代码时最常见的一条** |
| `failed` | 安装失败 | 看 `failedAt` 与 `problem` |
| `overridden` | 被更高优先级的层覆盖 | 查 patch 里有没有同 id 的别的行 |

`problem` 取值与处置：

| problem | 意思 | 处置 |
| --- | --- | --- |
| `invalid-spec` | 路径/target 写错 | 用**绝对路径**，别用相对路径 |
| `not-a-package` | 目录里没有合法 `package.json` | 确认填的是 `D:\大烧货\工作区\qq-companion` 这一层 |
| `not-a-bundle` | `package.json` 没有 `dsh.bundle.patch` | 确认文件没被改坏；`node test/bundle.test.mjs` 会先红 |
| `already-installed` | 同名已装 | 用 update，或先 remove |
| `network` | 需要联网（git/npm 目标） | 本地目录安装不需要联网；看到了说明填的是 git 地址 |

## 装上了但 QQ 不回

**先看面板最上面的「体检」**，五项逐条 ✅❌，红的那行就是原因：

| 体检项 | ❌ 说明 | 怎么办 |
| --- | --- | --- |
| 主人 QQ | 没填 → 她谁都不回（刻意的，宁可沉默也不乱回） | 面板下面的设置表里填 |
| QQ 网关 | `stopped`：`enabled=false` 或 `wsUrl` 为空；`reconnecting`：连不上 | 看 SnowLuma 是否登录、端口/token 对不对 |
| 发送地址 | 没填 `httpUrl` → 收得到但发不出 | 填 HTTP 地址（注意可能和 WS 不是同一个端口） |
| 模型 | DSH 里没有可用 provider | 去 DSH 设置里配一个 API key |
| 人格卡 | 对应名字的 `.md` 不存在 | 改配置里的人格名，或重启让它写默认卡 |

体检全绿还不回，再按这两条查：

1. **模型报错** → 宿主日志里有 `模型调用失败：<code>`；`NO_ADAPTER` 是 provider 没选中。
2. **沉默了但没报错** → 看 `/api/state` 的 `recalls` 与 `session.size`：会话在涨说明它在想，
   只是这轮没说话（空回复不写历史、不发送）。

## 已知的"安静失败"

- `apply` 兜底：插件启动失败会写日志但不炸宿主——**日志里没红字不等于它在工作**，要用面板/自检确认。
- **面板 404 但 QQ 还能收发**：说明 `inject` 里少了 `webServer`。cordis 的服务是代理，没声明就抛，
  那一句在 `createHost` 中段，抛了之后面板/主动搭话/启动诊断全不执行，而网关因为更早启动还在跑。
  现在 `inject = ['llm', 'webServer']` 已经写了；如果你改过清单，先查这里。
- 空回复：模型返回空串时不发送、也不写历史，看起来像"没反应"。真出现请抓 `session.size` 有没有涨。
