// 陪伴体：只服务主人私聊、会因一句话改状态、把状态注入上下文。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanion } from '../src/companion.js';
import { initState } from '../src/affect/core.js';

const T0 = Date.UTC(2026, 0, 1);

function setup({ ownerQQ = '42', memoryBlock } = {}) {
  let st = initState(T0);
  const prompts = [];
  const companion = createCompanion({
    load: () => st,
    save: (s) => { st = s; },
    session: { prompt: async (chatId, text, extra) => prompts.push({ chatId, text, extra }) },
    ownerQQ,
    now: () => T0,
    memoryBlock,
  });
  return { companion, prompts, state: () => st };
}

const msg = (over = {}) => ({ chatId: 'private:42', kind: 'private', userId: '42', text: '你好', ...over });

test('主人的私聊：交给会话，并带上状态上下文', async () => {
  const { companion, prompts } = setup();
  const r = await companion.handleMessage(msg({ text: '你好可爱' }));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].chatId, 'private:42');
  assert.match(prompts[0].extra.context, /不要说出口/);
  assert.ok(r.state.emotion.v > 0.5, '被夸之后效价上升');
});

test('没配主人：谁都不回，也不写任何状态', async () => {
  const { companion, prompts, state } = setup({ ownerQQ: '' });
  const before = state();
  const r = await companion.handleMessage(msg({ text: '你好可爱' }));
  assert.equal(r.ignored, 'no-owner');
  assert.equal(prompts.length, 0, '没配主人时不能回任何人');
  assert.equal(state(), before, '陌生人的话不能污染她的状态');
});

test('被夸：关系会往上走一点，不是只有挨骂才变', async () => {
  const { companion, state } = setup();
  await companion.handleMessage(msg({ text: '你今天真棒' }));
  assert.ok(state().relation.trust > 0.5, '被认真对待应该涨信任');
  assert.ok(state().relation.intimacy > 0.4);
});

test('被骂：关系真的变差，不是只写在提示词里', async () => {
  const { companion, state } = setup();
  const r = await companion.handleMessage(msg({ text: '闭嘴' }));
  assert.ok(r.damage > 0);
  assert.ok(state().relation.trust < 0.5);
  assert.ok(state().relation.guard > 0.2);
});

test('陌生人私聊：忽略，且不产生状态变化', async () => {
  const { companion, prompts, state } = setup();
  const r = await companion.handleMessage(msg({ userId: '999', chatId: 'private:999' }));
  assert.deepEqual(r, { ignored: 'not-owner' });
  assert.equal(prompts.length, 0);
  assert.equal(state().relation.trust, 0.5);
});

test('群聊：这一版不处理', async () => {
  const { companion, prompts } = setup();
  const r = await companion.handleMessage(msg({ kind: 'group', chatId: 'group:9', groupId: '9' }));
  assert.deepEqual(r, { ignored: 'not-private' });
  assert.equal(prompts.length, 0);
});

test('记忆块：取到就拼进上下文，取不到也不挡回复', async () => {
  const ok = setup({ memoryBlock: async () => '【记忆】他喜欢猫' });
  await ok.companion.handleMessage(msg());
  assert.match(ok.prompts[0].extra.context, /他喜欢猫/);

  const broken = setup({ memoryBlock: async () => { throw new Error('board'); } });
  await broken.companion.handleMessage(msg());
  assert.match(broken.prompts[0].extra.context, /不要说出口/);
});

test('人格：被凶很多次、跨月之后才真的变化', async () => {
  const T = Date.UTC(2026, 0, 2);
  let clock = T;
  let st = initState(T);
  const companion = createCompanion({
    load: () => st,
    save: (s) => { st = s; },
    session: { prompt: async () => '嗯' },
    ownerQQ: '42',
    now: () => clock,
    memoryBlock: async () => '',
  });
  for (let i = 0; i < 5; i++) {
    clock = T + i * 86400e3;
    await companion.handleMessage(msg({ text: '闭嘴' }));
  }
  assert.ok(st.self.aggression >= 0.3, '整月结算前特质不该变');
  clock = Date.UTC(2026, 1, 2);
  await companion.handleMessage(msg({ text: '晚安' }));
  assert.ok(st.self.aggression > 0.3, `跨月后应漂移，实际 ${st.self.aggression}`);
  assert.ok(st.self.snapshots.length >= 1);
});

test('状态会落盘：下一次进来接着用', async () => {
  const { companion, state } = setup();
  await companion.handleMessage(msg({ text: '谢谢，辛苦了' }));
  const after = state().emotion.v;
  assert.ok(after > 0.5);
  const snap = companion.snapshot();
  assert.equal(snap.emotion.v, after);
});
