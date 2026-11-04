// 陪伴体的大脑：消息进来 → 结算状态 → 评估 → 注入上下文 → 交给会话生成。
//
// 刻意不碰网络、不碰 DSH：I/O 全在 host 层，这样"它对这句话该怎么反应"可以离线判。

import { applyDamage, applyWarmth, pushEmotion, settle, stateHash } from './affect/core.js';
import { appraise } from './affect/appraise.js';
import { buildContext } from './affect/inject.js';
import { monthlyDrift, notePattern } from './affect/personality.js';

// 反复出现的事才会改性格：这里只登记证据，改不改由月度结算决定。
const PATTERN_DELTAS = {
  被凶: { aggression: 0.01, sensitivity: 0.01 },
  被夸: { sensitivity: -0.005 },
  低落: { attachment: 0.01 },
};

/**
 * @param {object} o
 * @param {() => object} o.load 读状态
 * @param {(st: object) => void} o.save 写状态
 * @param {{prompt: (chatId: string, text: string, extra?: object) => Promise<any>}} o.session 会话通道
 * @param {string} [o.ownerQQ] 只服务这一个人；留空表示谁都不回（没配主人时宁可不说话）
 * @param {() => number} [o.now]
 * @param {(msg: object) => Promise<string>} [o.memoryBlock] 记忆块（由 meow-memory 或自建提供）
 * @param {() => Promise<string>} [o.extraContext] 「她此刻在干什么」这一类由上层拼的上下文
 */
export function createCompanion({ load, save, session, ownerQQ = '', now = Date.now, memoryBlock = async () => '', extraContext = async () => '' }) {
  return {
    async handleMessage(msg) {
      if (msg.kind !== 'private') return { ignored: 'not-private' };
      // 没配主人 ≠ 谁都能聊：默认闭嘴，否则陌生人的话会写进她的记忆和情绪。
      if (!ownerQQ) return { ignored: 'no-owner' };
      if (String(msg.userId) !== String(ownerQQ)) return { ignored: 'not-owner' };

      const t = now();
      let st = settle(load(), t);
      const a = appraise(msg.text, { direct: true });
      if (a.emotion) st = pushEmotion(st, a.emotion, t);
      if (a.damage > 0) st = applyDamage(st, a.damage, t).state;
      // 被认真对待会加温：只涨信任/亲密，不动戒备（戒备只能靠时间回落）。
      if (a.emotion?.label === '被夸') st = applyWarmth(st, 0.01, t).state;
      if (a.emotion?.label && PATTERN_DELTAS[a.emotion.label]) {
        st = notePattern(st, a.emotion.label, PATTERN_DELTAS[a.emotion.label], t);
      }
      st = monthlyDrift(st, t).state; // 同月是空操作；跨月才结算
      save(st);

      const context = buildContext(st);
      const memory = await memoryBlock(msg, { mood: st.emotion }).catch(() => '');
      // 「她此刻在干什么」由 host 拼（要读 life.json、要问她），这里只负责接上去。
      const life = await extraContext().catch(() => '');
      const reply = await session.prompt(msg.chatId, msg.text, { context: [context, life, memory].filter(Boolean).join('\n') });

      return { state: st, context, damage: a.damage, hash: stateHash(st), reply };
    },

    /** 面板/调试用：不产生副作用地看一眼当前状态。 */
    snapshot() {
      return settle(load(), now());
    },
  };
}
