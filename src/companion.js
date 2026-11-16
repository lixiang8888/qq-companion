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
 * @param {(msg: object) => Promise<string>} [o.extraContext] 「她此刻在干什么」这一类由上层拼的上下文
 * @param {(reply: string) => Promise<string>} [o.refine] 她说出 `[查:…]` 时，去查、把材料拿回来；
 *   返回非空就带着材料再问她一遍，用第二版回复
 */
export function createCompanion({ load, save, session, ownerQQ = '', now = Date.now, memoryBlock = async () => '', extraContext = async () => '', refine = null, extraImages = () => [] }) {
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

      const context = buildContext(st, t);
      // heat 决定这条记忆热不热（直接影响她多久忘掉它）。认不出情绪的句子原本只能靠
      // 上一次情绪的残留强度，等于「你吼了一句」和「今天吃了黄焖鸡」一样轻。
      // appraise 现在给一个兜底热度；真的一点分量都没有的闲话仍然传 null，走老路。
      const heat = Number(a.heat) > 0 ? a.heat : null;
      const memory = await memoryBlock(msg, { mood: st.emotion, heat }).catch(() => '');
      // 「她此刻在干什么」由 host 拼（要读 life.json、要看这一轮是什么场合），这里只负责接上去。
      const life = await extraContext(msg).catch(() => '');
      // 他自己发的图 + 这一轮她想重看的那张（最多一张，host 按分数决定要不要贴）。
      const reopen = (extraImages?.() || []).slice(0, 1);
      const reply = await session.prompt(msg.chatId, msg.text, {
        context: [context, life, memory].filter(Boolean).join('\n'),
        images: [...(msg.images || []), ...reopen],
      });

      // 她自己说要查东西：查完带材料再问一遍。只重来一次——查完还要查，那是另一个量级的事。
      if (refine) {
        const extra = await refine(reply).catch(() => '');
        if (extra) {
          const again = await session.retry([context, life, memory, extra].filter(Boolean).join('\n'));
          return { state: st, context, damage: a.damage, hash: stateHash(st), reply: again, searched: true };
        }
      }

      return { state: st, context, damage: a.damage, hash: stateHash(st), reply };
    },

    /** 面板/调试用：不产生副作用地看一眼当前状态。 */
    snapshot() {
      return settle(load(), now());
    },
  };
}
