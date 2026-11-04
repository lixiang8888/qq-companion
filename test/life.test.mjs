// 她的「当下」：此刻在做什么、到几点。纯状态机，时钟注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, applyPlan, createLife, lifeLine, offLine, parsePlan } from '../src/life.js';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MIN = 60e3;
const DAY = 86400e3;

test('到点后清空：不再报告在做什么', () => {
  const life = applyPlan(createLife(T0), { doing: '在看书', minutes: 30 }, T0);
  assert.equal(advance(life, T0 + 10 * MIN).doing, '在看书');
  assert.equal(advance(life, T0 + 31 * MIN).doing, '');
});

test('刚装好时没有当下：别硬编一个', () => {
  const life = createLife(T0);
  assert.equal(life.doing, '');
  assert.equal(lifeLine(life, T0), '');
});

test('解析她回的那一行：全角竖线也算', () => {
  assert.deepEqual(parsePlan('在看书|30'), { doing: '在看书', minutes: 30 });
  assert.deepEqual(parsePlan('在收拾东西｜45'), { doing: '在收拾东西', minutes: 45 });
  assert.deepEqual(parsePlan('  \n在发呆 | 20 \n'), { doing: '在发呆', minutes: 20 });
});

test('解析不出来就返回 null，不猜', () => {
  for (const bad of ['', '不知道', '在看书', '|30', '在看书|', null, undefined]) {
    assert.equal(parsePlan(bad), null, `不该解析出东西：${bad}`);
  }
});

test('分钟数夹在 5~180：她说「一分钟」也当五分钟', () => {
  assert.equal(parsePlan('在喝水|1').minutes, 5);
  assert.equal(parsePlan('在睡觉|9999').minutes, 180);
  assert.equal(applyPlan(createLife(T0), { doing: '在睡觉', minutes: 9999 }, T0).until, T0 + 180 * MIN);
});

test('她的当下只能是一行、有上限：不能借这个字段往提示词里塞东西', () => {
  const long = `在\n看\n书${'啊'.repeat(500)}`;
  const plan = applyPlan(createLife(T0), { doing: long, minutes: 30 }, T0);
  assert.ok(!plan.doing.includes('\n'), '换行会破坏注入块');
  assert.ok(plan.doing.length <= 40, `太长：${plan.doing.length}`);
  assert.equal(lifeLine(plan, T0).split('\n').length, 1);
});

test('重启后 until 早已过去：清掉，别让她一直以为自己在看书', () => {
  const life = applyPlan(createLife(T0), { doing: '在看书', minutes: 60 }, T0);
  const woke = advance(life, T0 + 3 * DAY);
  assert.equal(woke.doing, '');
  assert.equal(woke.until, 0);
});

test('时钟被拨回或文件被改坏：until 超上限一律当过期', () => {
  const broken = { doing: '在看书', until: T0 + 365 * DAY };
  assert.equal(advance(broken, T0).doing, '');
  assert.equal(advance({ doing: '在看书' }, T0).doing, '');
  assert.equal(advance(null, T0).doing, '');
});

test('没答出来也别每句都再问一遍：留一个五分钟的重试闸', () => {
  const idle = applyPlan(createLife(T0), { doing: '', minutes: 30 }, T0);
  assert.equal(idle.doing, '');
  assert.equal(idle.until, T0 + 5 * MIN);
  assert.equal(advance(idle, T0 + 1 * MIN).until, T0 + 5 * MIN);
  assert.equal(advance(idle, T0 + 6 * MIN).until, 0);
});

test('生活线用本地时间说「到几点」', () => {
  const until = new Date(2026, 0, 1, 21, 40).getTime();
  const line = lifeLine({ doing: '在收拾东西', until }, until - 10 * MIN);
  assert.match(line, /在收拾东西/);
  assert.match(line, /21:40/);
});

// ---- 她「不在了」多久 ----
const boot = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();

test('关机九小时：开机后她知道刚才没有自己', () => {
  const lastBefore = boot(27, 22, 14);
  const bootAt = boot(28, 8, 0);
  const line = offLine({ lastBefore, bootAt, now: bootAt + MIN });
  assert.match(line, /9 小时 46 分/);
  assert.match(line, /昨天 22:14/);
  assert.match(line, /没有你/, '这是事实，不是台词');
});

test('只关机两分钟（改个插件重启）：别提，那不像她的经历', () => {
  const lastBefore = boot(28, 8, 0);
  assert.equal(offLine({ lastBefore, bootAt: boot(28, 8, 2), now: boot(28, 8, 3) }), '');
});

test('开机两小时后不再翻旧账：这句话只说给刚醒来的她', () => {
  const lastBefore = boot(27, 22, 14);
  const bootAt = boot(28, 8, 0);
  assert.equal(offLine({ lastBefore, bootAt, now: bootAt + 3 * 3600e3 }), '');
});

test('第一次装：没有上次，别提', () => {
  assert.equal(offLine({ lastBefore: 0, bootAt: boot(28, 8), now: boot(28, 9) }), '');
  assert.equal(offLine({ lastBefore: boot(29, 8), bootAt: boot(28, 8), now: boot(28, 9) }), '', '时钟被拨回也不能编');
});

test('关机好几天：说天，不说小时', () => {
  const line = offLine({ lastBefore: boot(20, 22), bootAt: boot(28, 8), now: boot(28, 8) });
  assert.match(line, /7 天/);
  assert.match(line, /10月20日 22:00/);
});
