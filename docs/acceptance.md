# 验收报告：目标做到了什么程度

> 目标原文：「私人聊天，长时间的，陪伴式的，有情绪的，有人格，有人格变化的，能长期管理记忆不失控的，可以接入qq聊天的。」
>
> 这份报告只写**能复现的证据**。没验的一律写“未覆盖”，不写成“应该没问题”。

## 一句话

软件部分全部完成并在真 DSH 0.2.1-rc.3 里跑通；**没验的只剩「真 SnowLuma + 真模型 key」和
「像不像人」这种只能由人判断的东西**。

## 逐条对照

| 目标条款 | 怎么验的 | 结论 | 未覆盖 |
| --- | --- | --- | --- |
| 私人聊天 | 真宿主里由假 OneBot 推私聊事件 → 回复经 HTTP 发出；群消息/陌生人/空消息被忽略 | ✅ | 真 QQ 客户端 |
| 长时间 | 会话落盘、摘要压缩；`QQC_DAYS=365` 长跑；真宿主 40 轮触发 3 次压缩 | ✅ | 真模型写的摘要质量 |
| 陪伴式 | 私聊版人格卡；主动搭话（期待时间 + 连发上限 2 条，至少 3 小时没说话）；拆条与延迟 | ⚠️ 功能在，**好不好只有人知道** | 真人主观判断 |
| 有情绪 | 四层状态 + 半衰期 + 规则评估；影响回复延迟与条数 | ✅ | — |
| 有人格 | 人格卡真的进了系统提示（真宿主 `persona=true`） | ✅ | — |
| 有人格变化 | 模拟 8 个月被凶：特质移动、7 版快照、叙事「我最近更容易顶回去了」进提示 | ✅ | 真实几个月的效果 |
| 记忆不失控 | 400 天压力测试：3000 条上限下 10 条长期事实 **10/10 存活**；锚点不丢；问「过敏」排第 2 | ✅ | 真对话里的召回准确率 |
| 可以接入 QQ | OneBot 11 客户端（WS 收 + HTTP 发 + 鉴权 + 退避），真宿主里连上、收到、发出 | ✅ | **真 SnowLuma 的鉴权/心跳/字段** |

## 复现命令

```bash
npm test                                   # 187 项，约 1 秒
QQC_DAYS=365 node --test --test-isolation=none "test/long-run.test.mjs"   # 一年长跑
node scripts/preflight.mjs --install --online   # 装没装上 / OneBot 通不通
```

真宿主端到端（不碰你的 DSH，`DSH_HOME` 指到工作区里）：

```powershell
$env:DSH_HOME = 'D:\大烧货\工作区\.dsh-scratch'
dsh --profile scratch --from-default-profile web --dump-config
dsh plugin --profile scratch add 'file:D:\大烧货\工作区\qq-companion'
# 另开窗口：node scripts/mock-stack.mjs
$env:DEEPSEEK_API_KEY='dummy'; $env:DEEPSEEK_BASE_URL='http://127.0.0.1:18080'
dsh --profile scratch --no-open
```

观察到：`persona=true`（人格卡到了模型）、`messages=1 → 3`（两轮上下文）、
`send_private_msg {"user_id":42,"message":[{"type":"text","data":{"text":"在呢"}}]}`、
`/api/state` 200 且 `gateway=connected`。

## 明确没做

群聊、多对象、语音/表情包、控制台 3100、审批、定时任务、生图/翻唱、双盲验收、D 轴、
DSH 窗口管理插件、工具调用（联网搜索/看图）。

## 上线前你要自己确认的三件事

1. **真 SnowLuma 能连上**：面板体检「QQ 网关」变成 `connected`。
2. **真模型能回话**：发一句「在吗」，1~2 秒内收到 1~3 条短回复。
3. **她像不像那只大肥鱼**：这条没有测试能替你判断。如果不像，先改人格卡，不要改情绪参数。
