// QQ 空间封装：只钉「参数怎么组、错误怎么分类、返回怎么归一化」，不碰真网关。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UGC, MAX_TEXT_CHARS, QzoneError,
  comment, detail, freshComments, normalizeComments, publish, remove,
} from '../src/qzone.js';

/** 假 onebot：记录调用，按预设返回值或抛错。 */
function fake({ result = null, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async call(action, params) {
      calls.push({ action, params });
      if (fail) throw new Error(fail);
      return typeof result === 'function' ? result(action, params) : result;
    },
  };
}

test('发说说：默认好友可见，返回 tid 和时间', async () => {
  const bot = fake({ result: { tid: 'abc123', time: 1793882610 } });
  const out = await publish(bot, '今天有点累');
  assert.deepEqual(out, { tid: 'abc123', at: 1793882610 });
  assert.equal(bot.calls[0].action, 'send_qzone_msg');
  assert.equal(bot.calls[0].params.ugc_right, UGC.friends);
  assert.equal(bot.calls[0].params.content, '今天有点累');
});

test('发说说：空内容不往网关走', async () => {
  const bot = fake();
  await assert.rejects(() => publish(bot, '   '), (e) => e instanceof QzoneError && e.code === 'qzone-empty');
  assert.equal(bot.calls.length, 0, '本地能判出来的错不该花一次网络');
});

test('发说说：超长直接拒，不截断（截断会把话说一半发出去）', async () => {
  const bot = fake();
  const long = '字'.repeat(MAX_TEXT_CHARS + 1);
  await assert.rejects(() => publish(bot, long), (e) => e.code === 'qzone-too-long');
  assert.equal(bot.calls.length, 0);
});

test('部分可见：没给 targetUins 就报错，不偷偷发成公开', async () => {
  const bot = fake({ result: { tid: 'x' } });
  await assert.rejects(() => publish(bot, '给你看', { ugcRight: UGC.some }), (e) => e.code === 'qzone-bad-params');
  assert.equal(bot.calls.length, 0, '权限参数不全时宁可发不出去');
});

test('部分可见：给了 targetUins 就传下去', async () => {
  const bot = fake({ result: { tid: 'x', time: 1 } });
  await publish(bot, '给你看', { ugcRight: UGC.some, targetUins: ['42', 43] });
  assert.deepEqual(bot.calls[0].params.target_uins, [42, 43]);
});

test('发出去但没有 tid：当失败，不然之后删不掉也读不到', async () => {
  const bot = fake({ result: { time: 1 } });
  await assert.rejects(() => publish(bot, '嗯'), (e) => e.code === 'qzone-no-tid');
});

test('未知动作被认出来：1424/unknown action 归到 action-missing', async () => {
  const bot = fake({ fail: 'get_qzone_comment_list 失败：retcode=1404 unknown action' });
  await assert.rejects(() => detail(bot, 't1'), (e) => e.code === 'qzone-action-missing');
});

test('授权失败与参数错误分开：401 和 1400 不能混成一类', async () => {
  await assert.rejects(() => publish(fake({ fail: 'send_qzone_msg 失败：HTTP 401' }), '嗯'),
    (e) => e.code === 'qzone-unauthorized');
  await assert.rejects(() => publish(fake({ fail: 'send_qzone_msg 失败：retcode=1400 content: must not be empty' }), '嗯'),
    (e) => e.code === 'qzone-bad-params');
});

test('删说说：没 tid 不猜', async () => {
  const bot = fake({ result: null });
  await assert.rejects(() => remove(bot, ''), (e) => e.code === 'qzone-no-tid');
  assert.equal(bot.calls.length, 0);
});

test('读评论：字段归一化，秒变毫秒', async () => {
  const bot = fake({
    result: {
      tid: 't1',
      content: '今天有点累',
      comment_num: 2,
      comments: [
        { comment_id: '11', uin: 42, name: '他', time: 1793882620, content: '抱抱', replies: [] },
        { comment_id: '12', uin: 7, name: '路人', time: 1793882700, content: '？', replies: [{}, {}] },
        { uin: 9, name: '没 id 的' },
      ],
    },
  });
  const out = await detail(bot, 't1');
  assert.equal(out.commentCount, 2);
  assert.equal(out.comments.length, 2, '没有 id 的评论丢掉，不然无法去重');
  assert.deepEqual(out.comments[0], { id: '11', uin: 42, name: '他', at: 1793882620 * 1000, text: '抱抱', replies: 0 });
  assert.equal(out.comments[1].replies, 2);
});

test('评论：空文本不发', async () => {
  const bot = fake({ result: { comment_id: '1' } });
  await assert.rejects(() => comment(bot, 't1', '  '), (e) => e.code === 'qzone-empty');
  assert.equal(bot.calls.length, 0);
});

test('评论：只在给了 targetUin 时才带这个参数', async () => {
  const bot = fake({ result: { comment_id: '9' } });
  await comment(bot, 't1', '嗯');
  assert.equal('target_uin' in bot.calls[0].params, false);
  await comment(bot, 't1', '嗯', { targetUin: 42 });
  assert.equal(bot.calls[1].params.target_uin, 42);
});

test('挑新评论：见过的 id 不再回，避免重复回复', () => {
  const list = normalizeComments([
    { comment_id: '1', content: 'a' },
    { comment_id: '2', content: 'b' },
  ]);
  assert.equal(freshComments(list, ['1']).length, 1);
  assert.equal(freshComments(list, []).length, 2);
  assert.equal(freshComments(null, ['1']).length, 0, '拿不到评论时不能当成「有新评论」');
});
