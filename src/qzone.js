// QQ 空间：发说说 / 删 / 读评论 / 回评论。
//
// 接口形状来自 2026-11-05 在 SnowLuma 2.4.0 上的实测，不是猜的：
//   send_qzone_msg      {content, ugc_right, target_uins?} → {tid, time}
//   delete_qzone_msg    {tid}                              → ok
//   get_qzone_msg_detail{tid}                              → {tid, content, comment_num, comments:[…]}
//   comment_qzone       {tid, content}                     → {comment_id}
//
// 注意：detail 只有对「自己发的」说说才有效（别人的 tid 会报 code=-8 原文已经被删除）。
// 所以读评论只读自己那条，别人的动态只能看不能回。

/** ugc_right 的取值，跟 QQ 一致。 */
export const UGC = { public: 1, friends: 4, some: 16, private: 64, hideSome: 128 };

/** 说说正文上限，保守取 1000（QQ 自己限制约 1000 字）。 */
export const MAX_TEXT_CHARS = 1000;

export class QzoneError extends Error {
  constructor(message, { code = 'qzone-failed', retcode = null } = {}) {
    super(message);
    this.name = 'QzoneError';
    this.code = code;
    this.retcode = retcode;
  }
}

async function call(onebot, action, params) {
  try {
    return await onebot.call(action, params);
  } catch (error) {
    const text = String(error?.message || error);
    // onebot.call 把 retcode 拼进消息里了（"xxx 失败：retcode=1404 …"），这里还原成分类。
    if (/HTTP 401|HTTP 403/.test(text)) throw new QzoneError(text, { code: 'qzone-unauthorized' });
    if (/HTTP 404/.test(text)) throw new QzoneError(text, { code: 'qzone-action-missing' });
    if (/retcode=1404/.test(text) || /unknown action/i.test(text)) throw new QzoneError(text, { code: 'qzone-action-missing' });
    if (/retcode=1400/.test(text)) throw new QzoneError(text, { code: 'qzone-bad-params' });
    throw new QzoneError(text, { code: 'qzone-rejected' });
  }
}

function checkText(text) {
  const content = String(text ?? '').trim();
  if (!content) throw new QzoneError('说说内容是空的', { code: 'qzone-empty' });
  if (Array.from(content).length > MAX_TEXT_CHARS) {
    throw new QzoneError(`说说太长（上限 ${MAX_TEXT_CHARS} 字）`, { code: 'qzone-too-long' });
  }
  return content;
}

/** 发一条说说。默认好友可见。 */
export async function publish(onebot, text, { ugcRight = UGC.friends, targetUins } = {}) {
  const content = checkText(text);
  const params = { content, ugc_right: ugcRight };
  if (ugcRight === UGC.some || ugcRight === UGC.hideSome) {
    const uins = (targetUins || []).map(Number).filter(Number.isFinite);
    if (!uins.length) throw new QzoneError('部分可见必须给 targetUins', { code: 'qzone-bad-params' });
    params.target_uins = uins;
  }
  const data = await call(onebot, 'send_qzone_msg', params);
  const tid = String(data?.tid ?? '');
  if (!tid) throw new QzoneError('发出去但没有拿到 tid', { code: 'qzone-no-tid' });
  return { tid, at: Number(data?.time ?? 0) };
}

/** 删掉自己的一条说说。 */
export async function remove(onebot, tid) {
  const id = String(tid ?? '').trim();
  if (!id) throw new QzoneError('要删哪条？给我 tid', { code: 'qzone-no-tid' });
  await call(onebot, 'delete_qzone_msg', { tid: id });
  return { tid: id };
}

/** 评论结构归一化：接口字段是 comment_id / name / time / content / replies。 */
export function normalizeComments(list) {
  return (Array.isArray(list) ? list : []).map((c) => ({
    id: String(c?.comment_id ?? c?.id ?? ''),
    uin: Number(c?.uin ?? 0),
    name: String(c?.name ?? c?.nickname ?? ''),
    at: Number(c?.time ?? 0) * 1000, // 接口给的是秒
    text: String(c?.content ?? ''),
    replies: Array.isArray(c?.replies) ? c.replies.length : 0,
  })).filter((c) => c.id);
}

/** 读自己这条说说下面的评论。别人的 tid 读不到（会报原文已被删除）。 */
export async function detail(onebot, tid) {
  const id = String(tid ?? '').trim();
  if (!id) throw new QzoneError('要读哪条？给我 tid', { code: 'qzone-no-tid' });
  const data = await call(onebot, 'get_qzone_msg_detail', { tid: id });
  return {
    tid: id,
    content: String(data?.content ?? ''),
    commentCount: Number(data?.comment_num ?? 0),
    comments: normalizeComments(data?.comments),
  };
}

/** 在自己的说说下面评论（回别人也在这一层，QQ 的回复是挂在评论下的）。 */
export async function comment(onebot, tid, text, { targetUin } = {}) {
  const id = String(tid ?? '').trim();
  if (!id) throw new QzoneError('要在哪条下面评？给我 tid', { code: 'qzone-no-tid' });
  const content = checkText(text);
  const params = { tid: id, content };
  if (Number.isFinite(Number(targetUin)) && Number(targetUin) > 0) params.target_uin = Number(targetUin);
  const data = await call(onebot, 'comment_qzone', params);
  return { commentId: String(data?.comment_id ?? '') };
}

/** 从一堆评论里挑出没见过的（按 id 去重），用来避免重复回复。 */
export function freshComments(comments, seenIds = []) {
  const seen = new Set((seenIds || []).map(String));
  return (comments || []).filter((c) => c.id && !seen.has(c.id));
}
