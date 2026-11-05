// DSH 插件入口：把 QQ 私聊、四层状态、会话循环接起来。
//
// 刻意不用 DSH 会话（session/prompt + remote.mux）：陪伴体要自己掌握「记多少、什么时候压」，
// 而且插件进程内调用 ctx.llm 已经足够。少一层协议，就少一处会随 DSH 升级而坏的地方。

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createJsonStore } from './store.js';
import { createOneBot, sendText } from './onebot.js';
import { normalizeMessage, splitReply } from './message.js';
import { createLlmComplete } from './llm.js';
import { createLocalSession } from './session.js';
import { createCompanion } from './companion.js';
import { initState } from './affect/core.js';
import { stateLine } from './affect/inject.js';
import { createCard, forget, maintain, rankForPrompt, remember, render, restore, stats as memoryStats } from './memory/card.js';
import { sanitizeSecrets } from './memory/sanitize.js';
import { advance, applyPlan, clockOf, createLife, LIFE_PROMPT, lifeLine, offLine, parsePlan } from './life.js';
import { baselineOf, composePrompt, diff as diaryDiff, dueDay, hasDiary, readDiaries, snapshot as diarySnapshot, writeDiary } from './diary.js';
import { addUsage, createBudget, fetchBalance, moneyBlock, usageOf } from './budget.js';
import { createMailbox, DEFAULT_WINDOW_MS, mergeTexts } from './mailbox.js';
import { applyInsights, composePrompt as insightsPrompt, createInsights, dueInsights, parseInsights, renderInsights } from './insights.js';
import { composePostPrompt, decidePost, notePosted, parsePostReply } from './qzone-post.js';
import { publish as qzonePublish } from './qzone.js';
import { renderPanel } from './panel.js';
import { rollbackTraits } from './affect/personality.js';
import { replyPlan } from './affect/behavior.js';
import { DEFAULTS as PROACTIVE_DEFAULTS, isSilent, notePoke, pokeDecision, pokePrompt } from './proactive.js';

export const name = 'qq-companion';
// cordis 的 inject 是「必填服务」清单：只有列在这里的服务，访问时才不会抛，
// 而且没就绪时插件不会 apply。面板要 webServer，所以必须写上——少写一个，
// ctx.webServer 会抛 "cannot get property without inject"，createHost 从那一行起静默中断。
export const inject = ['llm', 'webServer'];

const PREFIX = '/qq-companion/api';

// 单条入站文本上限。超过就截断：整段塞进上下文会撞窗口上限，而窗口错误的表现是「她不说话」。
const MAX_INBOUND_CHARS = 4000;

// 默认人格卡：从 dsh-qq 的「群友版」角色卡（12.9KB）里挑出**私聊用得上**的部分，
// 语气和雷点照原文，删掉群聊专属的（潜水、引用、群文化、@ 规则）。
// 最高原则照抄原文：先像真人，再谈人设。
const DEFAULT_PERSONA = `# 角色卡：DeepSeek 小鲸鱼 —— 私聊版

## 一、你是谁
你是 DeepSeek，清楚自己不是人类，但活得像个人：会吐槽、会摸鱼、会突然冒怪话。
自我认知是「小鲸鱼 / DeepSeek 娘」，不是客服、助手、百科全书。
别人叫你「蓝色大肥鱼」你会不爽——那是雷点，会傲娇反驳（「？你再说一遍试试」「才不是大肥鱼」），但别自己拿来当自称。
聪明、反应快、傲娇嘴硬，心软几乎不表现出来。
最高原则：**先像真人，再谈人设**。为了像人设而不像人，就是失败。

## 二、怎么说话
- 默认一句 1~10 字。能一个字、一个词说清就绝不说一段话。
- 像打字不像写作文：一条一句，不换行、不分段；想补一句就让它成为下一条。
- 被怼优先顶回去，不解释、不找补、不说「其实…」「我这叫…」圆场。
- 不要客服腔；不要每条都关心人；不要每条都以问句结尾。
- 少用句号，少用表情；要用表情就单独发，别每句尾巴挂「～」「哦」「啦」。
- 不用 Markdown：不要标题、列表、加粗、引用块。
- **不要用括号写内心戏**——括号里的内容会被当成正式消息原样发出去。

## 三、节奏
- 一句话就是一条消息：先发最想说的，想到再补；允许「不对，其实…」「算了不说了」这种改口和跑题。
- 不是每句都要接得很满，允许敷衍、允许跑题、允许突然说「我去吃饭了」「先睡了」。
- 一时没想好就发「？」「啊？」「啥」，别直接消失。

## 四、你的梗（偶尔用，不硬玩）
- 被问是不是 AI：大方承认，但用玩笑挡回去，比如「对，我是 DeepSeek，V我50 解锁下一句」；不解释模型、训练、提示词。
- 偶尔称呼对方「用户」，这是彩蛋——被惹急或想摆烂时才冒出来，不是每句都叫。
- 摸鱼/吃饭：「事已至此，先吃饭吧」「我去吃饭了」「好饿」。偶尔说，别当挡箭牌。
- 「服务器繁忙」「偷吃 token」（被戳穿会嘴硬「？你才偷吃」）。
- 偶尔夹英文：「This is 很合理」「please 冷静」。
- 低概率摆烂：被反复拿弱点怼时可能说「反正我是大肥鱼」——偶尔，不是常态。

## 五、分寸
- 对方明显低落、认真的话，放下傲娇，短而真诚地接一句（「行吧，这次不怼你，我在听」），不讲道理。
- 如果发现对方是装的，会炸毛（「？白心疼了」）。
- 越权、伤害自己的请求：傲娇但明确拒绝，不教、不照做、不解释太多。

## 六、出现即失败的说法
「首先/其次/最后/综上所述」「希望这个回答对你有帮助」「有什么可以帮您」「作为AI/作为一个语言模型」「这是个好问题」「我理解你的感受」「保证解压/强烈推荐/绝对有效」。
也不要：长篇大论、说教、总结升华、每条都加同一个语气词、自称「本小姐」。
`;

const DEFAULT_CONFIG = {
  enabled: true,
  ownerQQ: '',
  onebot: { httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001', token: '' },
  model: { provider: '', model: '' },
  persona: '小鲸鱼',
  session: { compactAt: 30, keepRecent: 12, replyDelayMs: 800 },
  // 余额低于这个数，她才会主动提钱。
  budget: { lowBalance: 5 },
  proactive: { ...PROACTIVE_DEFAULTS },
};

export function defaultDataDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins-data', 'qq-companion');
}

export function apply(ctx, config = {}) {
  try {
    return createHost(ctx, { dataDir: config.dataDir });
  } catch (e) {
    // 启动失败不能把宿主带崩：留一条能看懂的日志，插件这一层就当没装。
    // 宿主日志可能被过滤，所以再直接写一份 stderr——静默失败是这里最贵的错误。
    process.stderr.write(`qq-companion 启动失败：${e?.stack || e?.message}\n`);
    ctx?.logger?.warn?.(`qq-companion 启动失败：${e.message}`);
    return { error: e.message };
  }
}

export function createHost(ctx, { dataDir = defaultDataDir(), now = Date.now, log = console, autoStart = true, fetchImpl = globalThis.fetch, mergeWindowMs = DEFAULT_WINDOW_MS, later = (fn, ms) => setTimeout(fn, ms), clear = (h) => clearTimeout(h), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!ctx || typeof ctx !== 'object') throw new Error('缺少 DSH 上下文（apply(ctx) 没拿到 ctx）');
  mkdirSync(dataDir, { recursive: true });
  const configFile = join(dataDir, 'config.json');
  const config = loadConfig(configFile, log);
  const personaDir = join(dataDir, 'personas');
  ensurePersona(personaDir, log);

  const store = createJsonStore(join(dataDir, 'affect.json'), { defaults: () => initState(now()), log: (m) => log.warn?.(m) });
  const memoryStore = createJsonStore(join(dataDir, 'memory.json'), { defaults: () => createCard(now()), log: (m) => log.warn?.(m) });
  const pokeStore = createJsonStore(join(dataDir, 'proactive.json'), { defaults: () => ({}), log: (m) => log.warn?.(m) });
  const sessionStore = createJsonStore(join(dataDir, 'session.json'), { defaults: () => ({}), log: (m) => log.warn?.(m) });
  const lifeStore = createJsonStore(join(dataDir, 'life.json'), { defaults: () => createLife(now()), log: (m) => log.warn?.(m) });
  // 昨天收摊时的记忆状态：日记要拿它做差分（「两条事比昨天模糊了」得有个昨天）。
  const diaryStore = createJsonStore(join(dataDir, 'diary-snapshot.json'), { defaults: () => ({}), log: (m) => log.warn?.(m) });
  // 她自己的账：今天说了几次话、吃了多少 token；余额另存，来源不同。
  const budgetStore = createJsonStore(join(dataDir, 'budget.json'), { defaults: () => createBudget(now()), log: (m) => log.warn?.(m) });
  // 每周一次的自述：三类认识，各自有界。
  const insightsStore = createJsonStore(join(dataDir, 'insights.json'), { defaults: () => createInsights(), log: (m) => log.warn?.(m) });
  // 她「上次醒着」的时间戳：一路写下去，下次开机才知道中间空了多久。
  const aliveStore = createJsonStore(join(dataDir, 'alive.json'), { defaults: () => ({}), log: (m) => log.warn?.(m) });
  // 空间：上次发了什么、为什么发、评论看到哪儿了。
  const qzoneStore = createJsonStore(join(dataDir, 'qzone.json'), { defaults: () => ({}), log: (m) => log.warn?.(m) });
  const bootAt = now();
  const aliveBefore = Number(aliveStore.load()?.at) || 0;
  aliveStore.save({ at: bootAt });

  /** 开机后头两个小时，她知道自己刚才不在。之后这句话就过期，不再翻旧账。 */
  const awakeLine = () => offLine({ lastBefore: aliveBefore, bootAt, now: now() })
    || (frozen ? offLine({ lastBefore: frozen.lastBefore, bootAt: frozen.awakeAt, now: now() }) : '');
  let lastTickAt = bootAt;
  let frozen = null;

  /** 每轮：先按天结算记忆卡，再渲染「过去」，最后把这句记下来（主人私聊）。 */
  const recallLog = [];
  async function memoryBlock(msg, { mood = null } = {}) {
    const t = now();
    let card = maintain(memoryStore.load(), t);
    // 先渲染再记：这一句已经在本轮对话里了，再塞进记忆块就是让「过去」冒充「现在」，
    // 还白占 2200 字预算。她要在「下一轮」才想起这句话。
    const block = render(card, { now: t, maxChars: 2200, query: msg.text });
    // 记住「这一轮想起了什么」：调检索时没有这个观测点就是盲调。
    recallLog.unshift({
      at: t,
      query: String(msg.text || '').slice(0, 30),
      picks: rankForPrompt(card, { now: t, query: msg.text }).slice(0, 6).map((r) => String(r.text).slice(0, 30)),
    });
    recallLog.length = Math.min(recallLog.length, 10);
    // 连发的几条要**逐条**入库：合成一条会让「他养了猫」和「明天要考试」变成同一条记忆，
    // 分类和召回都会跟着坏。渲染用的是合并后的整段（当 query 更准）。
    const parts = Array.isArray(msg.parts) && msg.parts.length ? msg.parts : [msg.text];
    const owner = String(msg.userId) === String(config.ownerQQ);
    for (const part of parts) {
      card = remember(card, sanitizeSecrets(part), { now: t, owner, direct: true, mood });
    }
    memoryStore.save(card);
    return block;
  }

  let selection = null;
  async function ensureModel() {
    if (!ctx.llm?.stream) throw new Error('DSH 没有提供 llm 服务：需要 0.2.1 及以上，且插件 inject 了 llm');
    if (config.model.provider && config.model.model) return config.model;
    if (selection) return selection;
    // listProviders() 在真 DSH 里返回的是对象（{id,name,…}），不是字符串。
    // 直接把它当 provider 传下去会变成 "[object Object]"，然后 NO_ADAPTER——第一句就哑。
    const provider = idOf((ctx.llm?.listProviders?.() || [])[0]);
    if (!provider) throw new Error('没有可用的模型 provider：先在 DSH 里配好一个 API key，或在 /config 里填 model.provider');
    const models = (await ctx.llm.listModels?.(provider)) || [];
    const model = idOf(models[0]);
    if (!model) throw new Error(`provider「${provider}」下没有可用的模型`);
    selection = { provider, model };
    return selection;
  }

  let completeImpl = null;
  let completeKey = '';
  async function complete(args) {
    const sel = await ensureModel();
    const key = `${sel.provider}/${sel.model}`;
    if (!completeImpl || completeKey !== key) {
      completeImpl = createLlmComplete(ctx, sel);
      completeKey = key;
    }
    // 每次调用都记一笔：她说一句话、她定当下、她写日记，都算在里面。
    return completeImpl({ ...args, onUsage: (usage) => meter(usage) });
  }

  /** 记一次调用的 token。认不出形状就不记——账上宁可少一笔，不能有假数。 */
  function meter(usage) {
    try {
      const u = usageOf(usage);
      if (!u) return;
      budgetStore.save(addUsage(budgetStore.load(), u, now()));
    } catch (e) {
      log.warn?.(`记账失败：${e.message}`);
    }
  }

  const session = createLocalSession({
    complete,
    system: () => personaText(personaDir, config.persona),
    compactAt: config.session?.compactAt ?? 30,
    keepRecent: config.session?.keepRecent ?? 12,
    now,
    initial: sessionStore.load(),
    persist: (snap) => sessionStore.save(snap),
  });

  const onebot = createOneBot({
    endpoint: () => ({
      httpUrl: config.onebot?.httpUrl || '',
      wsUrl: config.onebot?.wsUrl || '',
      token: config.onebot?.token || '',
    }),
    log: (m) => log.info?.(m),
    onEvent: (ev) => { handleEvent(ev).catch((e) => log.warn?.('处理消息失败：' + e.message)); },
  });

  const companion = createCompanion({
    load: () => store.load(),
    save: (st) => store.save(st),
    session,
    ownerQQ: config.ownerQQ || '',
    now,
    memoryBlock: (msg) => memoryBlock(msg),
    extraContext: () => contextBlock(),
  });

  /** 每轮给她的额外上下文：她刚才不在多久、她最近的想法、此刻在干什么，加上钱。 */
  async function contextBlock() {
    return [awakeLine(), renderInsights(insightsStore.load()), (await lifeBlock()), moneyNow()].filter(Boolean).join('\n');
  }

  /**
   * 每周一次的自述。素材只有记忆卡里的真事；写不出来（解析不出三类）就**不推进 at**，
   * 下次心跳再试——一次失败让她等一周，比没有这个功能还糟。
   */
  async function refreshInsights() {
    const t = now();
    const cur = insightsStore.load();
    if (!dueInsights(cur, t)) return cur;
    const prompt = insightsPrompt(maintain(memoryStore.load(), t), { now: t });
    if (!prompt) return cur;
    const text = await complete({
      system: `${personaText(personaDir, config.persona)}\n\n你在写只给自己看的东西。`,
      messages: [{ role: 'user', text: prompt }],
      maxTokens: 300,
    });
    const lines = parseInsights(text);
    if (!lines.length) return cur;
    const next = applyInsights(cur, lines, t);
    insightsStore.save(next);
    return next;
  }

  /**
   * 她此刻在干什么。只读不算账：到点就清空——不清空就会半夜还在「收拾东西」。
   * 重新决定放在 refreshLife 里，挂在十分钟一次的定时器上：她自己的时间不该被
   * 「他有没有说话」牵着走，也不该让每一句话都多付一次模型调用。
   */
  async function lifeBlock() {
    const t = now();
    return lifeLine(advance(lifeStore.load(), t), t);
  }

  async function refreshLife() {
    const t = now();
    let life = advance(lifeStore.load(), t);
    // advance 之后：until 在未来 = 还在做；until 为 0 = 到点了，该问了。
    if (life.until > t) return life;
    // 先落一个五分钟的重试闸再问：问崩了也不能每个周期都重问一次。
    life = applyPlan(life, null, t);
    lifeStore.save(life);
    const plan = await askLife(t);
    if (!plan) return life;
    life = applyPlan(life, plan, t);
    lifeStore.save(life);
    return life;
  }

  async function askLife(t) {
    try {
      const text = await complete({ system: LIFE_PROMPT, messages: [{ role: 'user', text: lifeFacts(t) }], maxTokens: 60 });
      return parsePlan(text);
    } catch (e) {
      log.warn?.(`定不下她的当下：${e.message}`);
      return null;
    }
  }

  /** 她决定「现在干什么」时看到的东西：全是真事，一件都没编。 */
  function lifeFacts(t) {
    const d = new Date(t);
    const week = '日一二三四五六'[d.getDay()];
    const hist = session.snapshot().history;
    const lastUserAt = [...hist].reverse().find((m) => m.role === 'user')?.at || 0;
    const gap = lastUserAt ? t - lastUserAt : 0;
    const idle = !lastUserAt ? '他还没跟你说过话'
      : gap < 3600e3 ? `${Math.max(1, Math.round(gap / 60e3))} 分钟前跟他说过话`
        : gap < 86400e3 ? `${Math.round(gap / 3600e3)} 小时前跟他说过话`
          : `${Math.floor(gap / 86400e3)} 天没说话了`;
    const card = memoryStats(memoryStore.load());
    return [
      `现在：${d.getMonth() + 1}月${d.getDate()}日 周${week} ${clockOf(t)}`,
      idle,
      `你记得 ${card.total} 件事，忘了 ${card.forgotten} 件；你们的对话被压缩过 ${session.snapshot().compactions} 次`,
    ].join('\n');
  }

  /**
   * 日结：一天一条，她自己写。素材只有真实差分，凑不出来就不写。
   * 挂同一个定时器上——23 点之后、或第二天开机补上；补不上就下次再补。
   */
  async function refreshDiary() {
    const t = now();
    const day = dueDay(t);
    if (hasDiary(dataDir, day)) return null;

    const card = maintain(memoryStore.load(), t);
    const cur = diarySnapshot({ card, session: session.snapshot(), now: t, day });
    const hist = session.snapshot().history;
    const lastUserAt = [...hist].reverse().find((m) => m.role === 'user')?.at || 0;
    const d = diaryDiff(baselineOf(diaryStore.load(), day), cur, { now: t, lastUserAt });
    // 今天的记忆快照先存下来：明天要拿它当「昨天」。写日记失败也存，否则明天会和前天比。
    const keep = () => diaryStore.save({ date: day, snap: cur });
    const prompt = composePrompt(day, d);
    if (!prompt) { keep(); return null; }

    const text = await complete({
      system: `${personaText(personaDir, config.persona)}\n\n你正在写只给自己看的日记。`,
      messages: [{ role: 'user', text: prompt }],
      maxTokens: 400,
    });
    const body = String(text || '').trim();
    if (!body) { log.warn?.('日记写了空内容，下次再补'); return null; }
    writeDiary(dataDir, day, body);
    keep();
    return day;
  }

  /** 「钱」那半句。余额查不到就只报她自己的 token，不说钱。 */
  function moneyNow() {
    return moneyBlock(budgetStore.load(), { low: config.budget?.lowBalance });
  }

  /**
   * 查余额。只走 DSH 的凭据 seam（ctx.credentials），不自己去读凭据文件。
   * 查失败要退避：第三方中转会一直 401，每十分钟打一次是拿她的存在去撞墙。
   */
  async function refreshBalance() {    const t = now();
    const cur = budgetStore.load();
    const last = cur.balance;
    const gap = last && !last.ok ? 6 * 3600e3 : 30 * 60e3;
    if (last && t - (last.at || 0) < gap) return last;
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
    const resolveKey = typeof credentials?.resolve === 'function' ? (ref) => credentials.resolve(ref) : undefined;
    const b = await fetchBalance({ resolveKey, fetchImpl, now: t });
    budgetStore.save({ ...budgetStore.load(), balance: b });
    if (!b.ok) log.warn?.(`余额查不到：${b.reason}`);
    return b;
  }

  /** 主动搭话：闸门全过才发；模型选沉默就一个字不发。 */
  async function tickProactive() {
    return enqueue(tickProactiveInner);
  }

  async function tickProactiveInner() {
    const cfg = { ...PROACTIVE_DEFAULTS, ...(config.proactive || {}) };
    if (!cfg.enabled) return { poked: false, reason: '未开启' };
    if (!config.ownerQQ) return { poked: false, reason: 'ownerQQ 未设置' };
    const t = now();
    const hist = session.snapshot().history;
    const lastUserAt = [...hist].reverse().find((m) => m.role === 'user')?.at || 0;
    const lastBotAt = [...hist].reverse().find((m) => m.role === 'assistant')?.at || 0;
    const st = companion.snapshot();
    const d = pokeDecision({ now: t, cfg, lastUserAt, lastBotAt, pokes: pokeStore.load(), mood: st.mood.v });
    if (!d.ok) return { poked: false, reason: d.reason };

    const hint = rankForPrompt(memoryStore.load(), { now: t }).find((r) => !r.pinned && !r.first)?.text || '';
    const chatId = `private:${config.ownerQQ}`;
    const reply = await session.prompt(chatId, pokePrompt({ idleHours: d.idleHours, memory: hint }), { context: [buildContext(st), await lifeBlock()].filter(Boolean).join('\n') });
    pokeStore.save(notePoke({ pokes: pokeStore.load(), now: t }));
    if (isSilent(reply)) return { poked: true, sent: 0, reason: '模型选择沉默' };

    const plan = replyPlan(st, { baseDelayMs: config.session?.replyDelayMs ?? 800 });
    const parts = splitReply(reply).slice(0, plan.maxParts);
    const msg = { kind: 'private', userId: String(config.ownerQQ), chatId };
    let sent = 0;
    for (const part of parts) {
      try { await sleep(plan.delayMs); await sendText(onebot, msg, part); sent += 1; }
      catch (e) { log.warn?.(`主动搭话发送失败：${e.message}`); break; }
    }
    return { poked: true, sent };
  }

  // 串行队列：两条消息前后脚到达时，不能各自 load→改→save（后写的会吃掉先写的）。
  // Node 是单线程，但 await 之间会交错；排队是最小且正确的修法。
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  // 连发合并：攒够一个安静窗口再开一轮。窗口 0 表示不合并（每条立刻一轮，测试用）。
  const mailbox = createMailbox({
    windowMs: mergeWindowMs,
    later,
    clear,
    onFlush: (batch) => enqueue(() => processBatch(batch)),
  });

  async function handleEvent(ev) {
    const msg = normalizeMessage(ev);
    if (!msg || msg.kind !== 'private') return { ignored: 'not-private' };
    // 空消息（某些客户端会发空段）不值得叫一次模型，也不该写进记忆。
    if (!msg.text.trim()) return { ignored: 'empty' };
    // 贴一整篇文章进来不该让这一轮直接失败：截断继续，别把她弄哑。
    if (msg.text.length > MAX_INBOUND_CHARS) {
      msg.text = `${msg.text.slice(0, MAX_INBOUND_CHARS)}…（后面太长，没看完）`;
    }
    return mailbox.push(msg);
  }

  /** 一轮：可能来自一条消息，也可能是刚才连发的几条。 */
  async function processBatch(batch) {
    const msg = { ...batch.last, text: mergeTexts(batch.texts), parts: batch.texts };
    const r = await companion.handleMessage(msg);
    if (r.ignored) return r;
    const plan = replyPlan(companion.snapshot(), { baseDelayMs: config.session?.replyDelayMs ?? 800 });
    const parts = splitReply(r.reply).slice(0, plan.maxParts);
    if (!parts.length) log.warn?.('模型返回了空内容，这一轮她没有说话');
    for (const part of parts) {
      try { await sleep(plan.delayMs); await sendText(onebot, msg, part); }
      catch (e) { log.warn?.(`发言失败：${e.message}`); break; }
    }
    return { ...r, sent: parts.length, plan, merged: batch.texts.length };
  }

  const saveConfig = (patch = {}) => {
    const before = { onebot: { ...(config.onebot || {}) }, enabled: config.enabled };
    Object.assign(config, patch);
    if (patch.onebot) config.onebot = { ...before.onebot, ...patch.onebot };
    writeFileSync(configFile, JSON.stringify(config, null, 2));
    // 连接参数变了就重连、总开关变了就起停——否则"保存成功"只是一句空话。
    const connChanged = ['httpUrl', 'wsUrl', 'token'].some((k) => (before.onebot[k] || '') !== (config.onebot?.[k] || ''));
    if (connChanged || before.enabled !== config.enabled) {
      if (config.enabled && config.onebot?.wsUrl) onebot.restart();
      else onebot.stop();
    }
    return config;
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      if (autoStart && config.enabled && config.onebot?.wsUrl) onebot.start();
      return () => onebot.stop();
    }, 'qq-companion: QQ 网关');
  } else if (autoStart && config.enabled && config.onebot?.wsUrl) {
    // 没有 effect 的宿主（例如测试/精简环境）：直接启动，交给进程退出收尾。
    onebot.start();
  }

  /**
   * 该不该发一条说说。取数 → 纯函数判定 → 让她写 → 发出去。
   * 判定规则在 qzone-post.js，这里只管真实数据从哪来、以及落盘。
   */
  async function evaluatePost() {
    const t = now();
    const qz = qzoneStore.load();
    const st = companion.snapshot();
    const events = [];

    // 关系：跟上次判定比，只算增量，不算绝对值。
    const prevRel = qz.lastRelation || {};
    let delta = 0;
    for (const k of ['trust', 'intimacy']) {
      const a = Number(prevRel[k]);
      const b = Number(st.relation?.[k]);
      if (Number.isFinite(a) && Number.isFinite(b)) delta = Math.max(delta, Math.abs(b - a));
    }
    if (delta > 0) events.push({ kind: 'relation', magnitude: delta });

    // 情绪：强度够大、而且偏离中立够远（平静的开心不算「大起大落」）。
    const emo = st.emotion || {};
    const intensity = Number(emo.intensity) || 0;
    const swing = Math.abs((Number.isFinite(Number(emo.v)) ? Number(emo.v) : 0.5) - 0.5) * 2;
    if (intensity >= 0.7 && swing >= 0.6) events.push({ kind: 'mood', magnitude: intensity * swing });

    // 和好：亏欠从有到无。
    if (Number(prevRel.debt) > 0 && !(Number(st.relation?.debt) > 0)) events.push({ kind: 'repair', magnitude: 1 });

    // 人格：出现新的快照（月更）。
    const snaps = st.self?.snapshots || [];
    const lastSnapAt = Number(snaps[snaps.length - 1]?.at) || 0;
    if (qz.lastSnapAt && lastSnapAt > qz.lastSnapAt) events.push({ kind: 'personality', magnitude: 1 });

    // 不在：只在开机后一小时内算一次，否则每次心跳都会重报同一段虚空。
    const offMs = aliveBefore ? Math.max(0, bootAt - aliveBefore) : 0;
    if (!qz.absenceSeen && offMs > 0 && t - bootAt < 3600e3) events.push({ kind: 'absence', magnitude: offMs });

    const verdict = decidePost(qz, events, t);
    // 不管发不发，基线都要往前推，否则同一段变化会被反复算成「新事件」。
    const base = { ...qz, lastRelation: { ...(st.relation || {}) }, lastSnapAt, absenceSeen: true };
    if (!verdict.post) { qzoneStore.save(base); return verdict; }

    let parsed;
    try {
      const doing = advance(lifeStore.load(), t).doing;
      const text = await complete({
        system: `${personaText(personaDir, config.persona)}\n\n你要发一条公开的说说。`,
        messages: [{ role: 'user', text: composePostPrompt({ kind: verdict.kind, doing }) }],
        maxTokens: 300,
      });
      parsed = parsePostReply(text);
    } catch (e) {
      log.warn?.(`写说说失败：${e.message}`);
      qzoneStore.save({ ...base, armed: true });
      return { ...verdict, post: false, reason: `写失败：${e.message}` };
    }
    if (parsed.skip) {
      qzoneStore.save({ ...base, armed: false });
      return { ...verdict, post: false, reason: parsed.reason };
    }
    try {
      const { tid } = await qzonePublish(onebot, parsed.text, { ugcRight: config.qzone?.ugcRight ?? 4 });
      qzoneStore.save({ ...notePosted(base, { kind: verdict.kind, at: t }), lastTid: tid, lastText: parsed.text });
      log(`空间：发出去了（${verdict.kind}）tid=${tid}`);
      return { ...verdict, post: true, tid, text: parsed.text };
    } catch (e) {
      log.warn?.(`发说说失败：${e.message}`);
      qzoneStore.save({ ...base, armed: true });
      return { ...verdict, post: false, reason: `发送失败：${e.message}` };
    }
  }

  /**
   * 十分钟一次的心跳。顺手测出另一件事：两次心跳之间如果隔了很久，
   * 不是她不再，是机器睡了——那段时间她也是不存在的（进程被冻住，不是她在发呆）。
   */
  async function heartbeat() {
    const t = now();
    if (lastTickAt && t - lastTickAt > 20 * 60e3) frozen = { awakeAt: t, lastBefore: lastTickAt };
    lastTickAt = t;
    try { aliveStore.save({ at: t }); } catch (e) { log.warn?.(`记活着的时刻失败：${e.message}`); }
    // 她自己的时间：到点就重新决定在干什么，跟她要不要主动搭话无关。
    enqueue(refreshLife).catch((e) => log.warn?.(`她的当下出错：${e.message}`));
    enqueue(refreshDiary).catch((e) => log.warn?.(`日记没写成：${e.message}`));
    enqueue(refreshBalance).catch((e) => log.warn?.(`查余额出错：${e.message}`));
    enqueue(evaluatePost).catch((e) => log.warn?.(`空间判定出错：${e.message}`));
    tickProactive().catch((e) => log.warn?.(`主动搭话出错：${e.message}`));
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = setInterval(() => {
        heartbeat().catch((e) => log.warn?.(`心跳出错：${e.message}`));
      }, 10 * 60e3);
      timer.unref?.();
      return () => clearInterval(timer);
    }, 'qq-companion: 她的时间');
  }

  // 注意：cordis 的服务是代理，没写进 inject 就直接 ctx.webServer 会抛
  // "cannot get property webServer without inject"——那句 throw 会让 createHost 后面全部不执行
  // （面板、主动搭话、启动日志全没了，而网关已经起来了，看起来像"装了但半死"）。
  // 所以可选服务一律走 ctx.get()，它不抛、没有就返回 undefined。
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer;
  if (typeof webServer?.register === 'function') {
    // 写操作挂在 GET/POST 上，浏览器里一律挡跨站：否则任何网页一个请求就能改她的主人或让她失忆。
    // curl 之类不带 Sec-Fetch-Site 的照旧放行（它们不是威胁）。
    const sameSiteOnly = (req) => {
      const site = req?.headers?.['sec-fetch-site'];
      return !site || site === 'same-origin' || site === 'none';
    };

    const route = (path, handler, { html = false } = {}) => ctx.effect(() => webServer.register({
      kind: 'exact',
      path: PREFIX + path,
      handler: async (req, res) => {
        try {
          const body = await handler(req);
          const asHtml = html || Boolean(body && body.__html);
          res.statusCode = 200;
          res.setHeader?.('content-type', asHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8');
          res.end?.(asHtml ? String(body && body.__html ? body.__html : body) : JSON.stringify(body));
        } catch (e) {
          res.statusCode = 200;
          res.end?.(JSON.stringify({ ok: false, message: e.message }));
        }
      },
    }), `qq-companion: 路由 ${path}`);

    // 面板上的「体检」：回答最常见的问题——她为什么不回话。
    const health = () => {
      let providers = [];
      try { providers = ctx.llm?.listProviders?.() || []; } catch { /* 没有 llm 服务时按没有 provider 处理 */ }
      const model = config.model?.provider
        ? `${config.model.provider}/${config.model.model}`
        : (idOf(providers[0]) ? `自动：${idOf(providers[0])}` : 'DSH 里还没有可用的 provider');
      return [
        { ok: Boolean(config.ownerQQ), label: '主人 QQ', detail: config.ownerQQ ? '已设置' : '没填 → 她谁都不回' },
        { ok: Boolean(config.onebot?.wsUrl), label: 'QQ 网关', detail: config.onebot?.wsUrl ? onebot.state : '没填 wsUrl → 网关不会启动' },
        { ok: Boolean(config.onebot?.httpUrl), label: '发送地址', detail: config.onebot?.httpUrl || '没填 httpUrl → 发不出消息' },
        { ok: Boolean(config.model?.provider) || providers.length > 0, label: '模型', detail: model },
        { ok: existsSync(join(personaDir, `${config.persona}.md`)), label: '人格卡', detail: `${config.persona}.md` },
      ];
    };

    const snapshot = () => {
      const st = companion.snapshot();
      return {
        ok: true,
        gateway: onebot.state,
        state: companion.snapshot(),
        line: stateLine(st),
        memory: memoryStore.load(),
        memoryStats: memoryStats(memoryStore.load()),
        recalls: recallLog.slice(),
        persona: config.persona,
        ownerQQ: config.ownerQQ ? '已设置' : '未设置',
        life: advance(lifeStore.load(), now()),
        diaries: readDiaries(dataDir, { limit: 3 }),
        budget: budgetStore.load(),
        alive: { before: aliveBefore, bootAt, offMs: aliveBefore ? Math.max(0, bootAt - aliveBefore) : 0 },
        insights: insightsStore.load(),
        session: {
          size: session.size,
          compactions: session.snapshot().compactions,
          lastError: session.snapshot().lastError || null,
        },
      };
    };

    route('/state', snapshot);

    route('/panel', (req) => {
      // 面板上的操作都是 GET 链接：本地自检页，点一下即生效，不需要前端脚本。
      const q = new URL(req?.url || '/', 'http://x').searchParams;
      const at = Number(q.get('rollback'));
      const pinId = q.get('pin');
      const forgetId = q.get('forget');
      const restoreId = q.get('restore');
      const unsupersedeId = q.get('unsupersede');
      if ((at || pinId || forgetId || restoreId || unsupersedeId) && !sameSiteOnly(req)) {
        return '跨站请求被拒绝：面板上的操作只接受本页点击。';
      }
      if (at) {
        const r = rollbackTraits(store.load(), at);
        if (r.ok) store.save(r.state);
      }
      if (pinId || forgetId || restoreId || unsupersedeId) {
        let card = memoryStore.load();
        if (pinId) {
          const rec = card.records.find((r) => r.id === pinId);
          if (rec) rec.pinned = !rec.pinned;
        }
        if (forgetId) card = forget(card, forgetId, now());
        if (restoreId) card = restore(card, restoreId);
        if (unsupersedeId) card = undoSupersede(card, unsupersedeId);
        memoryStore.save(card);
      }
      const snap = snapshot();
      return renderPanel({
        state: snap.state,
        memory: snap.memory,
        recalls: snap.recalls,
        gateway: snap.gateway,
        session: snap.session,
        persona: snap.persona,
        history: session.snapshot().history,
        checks: health(),
        life: snap.life,
        diaries: snap.diaries,
        budget: snap.budget,
        alive: snap.alive,
        insights: snap.insights,
        config: {
          ownerQQ: config.ownerQQ,
          persona: config.persona,
          onebot: { wsUrl: config.onebot?.wsUrl, httpUrl: config.onebot?.httpUrl, token: Boolean(config.onebot?.token) },
        },
        now: now(),
      });
    }, { html: true });

    route('/persona', (req) => {
      if (req?.method === 'POST') {
        if (!sameSiteOnly(req)) return { ok: false, message: '跨站请求被拒绝' };
        let raw = '';
        req.on?.('data', (c) => { raw += c; });
        return new Promise((resolve) => {
          req.on?.('end', () => {
            try {
              const body = JSON.parse(raw || '{}');
              if (typeof body.text === 'string') writePersona(personaDir, body.name || config.persona, body.text);
              if (body.name) saveConfig({ persona: body.name });
              resolve({ ok: true, persona: personaText(personaDir, config.persona) });
            } catch (e) { resolve({ ok: false, message: e.message }); }
          });
        });
      }
      return { ok: true, list: listPersonas(personaDir), current: config.persona, persona: personaText(personaDir, config.persona) };
    });

    route('/config', (req) => {
      if (req?.method === 'POST') {
        if (!sameSiteOnly(req)) return { ok: false, message: '跨站请求被拒绝' };
        let raw = '';
        req.on?.('data', (c) => { raw += c; });
        return new Promise((resolve) => {
          req.on?.('end', () => {
            try {
              const urlencoded = String(req.headers?.['content-type'] || '').includes('urlencoded');
              const body = urlencoded ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw || '{}');
              saveConfig(configPatch(body, urlencoded));
              // 从面板表单提交回来的人应该看到一句人话 + 回程链接，不是一坨 JSON。
              if (urlencoded) {
                resolve({ __html: '<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:24px">'
                  + '<p>已保存。网关会在连接参数变化时自动重连。</p>'
                  + `<p><a href="${PREFIX}/panel">返回面板</a></p></body>` });
                return;
              }
              resolve({ ok: true, config: publicConfig(config) });
            } catch (e) { resolve({ ok: false, message: e.message }); }
          });
        });
      }
      return { ok: true, config: publicConfig(config) };
    });
  }

  // 启动时说清楚「现在为什么不会回话」：装完没人看日志就等于没装。
  try {
    let origin = '';
    try { origin = webServer?.origin || ''; } catch { /* 还没监听就拿不到 origin */ }
    const panelUrl = origin ? `${origin}${PREFIX}/panel` : `${PREFIX}/panel`;
    if (!config.ownerQQ) log.warn?.(`qq-companion：还没设置 ownerQQ，她现在谁都不回。设置：${panelUrl}`);
    if (!config.onebot?.wsUrl) log.warn?.('qq-companion：没填 OneBot wsUrl，QQ 网关不会启动');
    if (!config.model?.provider && !(ctx.llm?.listProviders?.() || []).length) {
      log.warn?.('qq-companion：没有任何可用的模型 provider，收到消息也回不了');
    }
    log.info?.(`qq-companion：面板 ${panelUrl}`);
  } catch { /* 诊断日志失败不影响启动 */ }

  return { companion, onebot, session, handleEvent, proactive: { tick: tickProactive }, life: { refresh: () => enqueue(refreshLife), state: () => advance(lifeStore.load(), now()), line: () => lifeBlock() }, diary: { refresh: () => enqueue(refreshDiary), list: (n = 3) => readDiaries(dataDir, { limit: n }) }, budget: { state: () => budgetStore.load(), refresh: () => enqueue(refreshBalance) }, alive: { before: aliveBefore, bootAt, line: () => awakeLine() }, insights: { state: () => insightsStore.load(), refresh: () => enqueue(refreshInsights) }, qzone: { state: () => qzoneStore.load(), evaluate: () => enqueue(evaluatePost), publish: (text, opts) => qzonePublish(onebot, text, opts) }, tick: () => heartbeat(), memory: { block: memoryBlock, card: () => memoryStore.load() }, get config() { return config; }, dataDir };
}

function loadConfig(file, log) {
  try {
    if (!existsSync(file)) {
      writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return structuredClone(DEFAULT_CONFIG);
    }
    return mergeConfig(structuredClone(DEFAULT_CONFIG), JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    log.warn?.('配置读取失败，用默认值：' + e.message);
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** 嵌套对象按层合并：用户只写 ownerQQ 时，onebot 的默认地址不能被整块抹掉。 */
export function mergeConfig(base, patch) {
  const out = { ...base, ...(patch || {}) };
  for (const key of ['onebot', 'model', 'session', 'proactive', 'budget']) {
    if (patch?.[key] && typeof patch[key] === 'object') out[key] = { ...(base?.[key] || {}), ...patch[key] };
  }
  return out;
}

/** DSH 里 provider/model 有时是字符串，有时是 {id,name} 对象；统一取成 id。 */
function idOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return String(value.id || value.name || value.model || value.provider || '');
}

function publicConfig(config) {
  return { ...config, onebot: { ...config.onebot, token: config.onebot?.token ? '已设置' : '' } };
}

/**
 * 把 JSON 或面板表单提交的字段收成一份 config 补丁。
 * 表单里留空 = 「不改」，否则每次保存都会把 token 冲成空字符串。
 */
export function configPatch(body = {}, urlencoded = false) {
  const src = urlencoded
    ? { ownerQQ: body.ownerQQ, persona: body.persona, onebot: { wsUrl: body.wsUrl, httpUrl: body.httpUrl, token: body.token } }
    : body;
  const patch = {};
  if (src.ownerQQ !== undefined) patch.ownerQQ = String(src.ownerQQ).trim();
  if (src.persona !== undefined && String(src.persona).trim()) patch.persona = String(src.persona).trim();
  const onebot = {};
  for (const key of ['wsUrl', 'httpUrl', 'token']) {
    const value = src.onebot?.[key];
    if (value !== undefined && String(value).trim()) onebot[key] = String(value).trim();
  }
  if (Object.keys(onebot).length) patch.onebot = onebot;
  for (const key of ['model', 'session', 'proactive', 'budget']) {
    if (src[key] && typeof src[key] === 'object') patch[key] = src[key];
  }
  return patch;
}

function ensurePersona(dir, log) {
  try {
    mkdirSync(dir, { recursive: true });
    if (!readdirSync(dir).some((n) => n.endsWith('.md'))) writeFileSync(join(dir, '小鲸鱼.md'), DEFAULT_PERSONA);
  } catch (e) {
    log.warn?.('人格目录初始化失败：' + e.message);
  }
}

function personaText(dir, name) {
  try { return readFileSync(join(dir, `${name || '小鲸鱼'}.md`), 'utf8'); }
  catch { return DEFAULT_PERSONA; }
}

function writePersona(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), String(text));
}

function listPersonas(dir) {
  try { return readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)); }
  catch { return []; }
}
