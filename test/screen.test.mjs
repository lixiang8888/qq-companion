// 她知不知道你在干什么：只读前台应用名 + 窗口标题，不截屏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TITLE, parseScreen, sanitize, screenLine } from '../src/screen.js';

const T = new Date(2026, 5, 1, 14, 0, 0).getTime();

test('解析：第一行进程名，第二行标题', () => {
  assert.deepEqual(parseScreen('Code\r\nqq-companion — host.js — Visual Studio Code\r\n'), {
    app: 'Code',
    title: 'qq-companion — host.js — Visual Studio Code',
  });
  assert.deepEqual(parseScreen('Code\n\n'), { app: 'Code', title: '' }, '没有标题也算读到了');
  assert.equal(parseScreen(''), null, '什么都没读到就是没读到，不许编');
});

test('标题里的控制字符压成空格，超长截断', () => {
  const got = parseScreen(`Code\n${'很长的标题'.repeat(30)}`);
  assert.equal(got.title.length, MAX_TITLE);
  const messy = parseScreen('Code\n标题\u0000里\u0007有控制字符');
  assert.equal(messy.title, '标题 里 有控制字符');
});

test('隐私：密码管理器整条不给，连应用名都不说', () => {
  assert.equal(sanitize({ app: '1Password', title: 'vault' }), null);
  assert.equal(sanitize({ app: 'KeePassXC', title: 'x' }), null);
});

test('隐私：聊天软件只说在哪个应用，不说窗口标题', () => {
  const wechat = sanitize({ app: 'WeChat', title: '微信 - 张三' });
  assert.equal(wechat.app, 'WeChat');
  assert.equal(wechat.title, '', '窗口标题就是联系人名字，不能进上下文');
});

test('隐私：标题命中敏感词就只留应用名', () => {
  assert.equal(sanitize({ app: 'chrome', title: '离婚协议 - Google 文档' }).title, '离婚协议 - Google 文档');
  assert.equal(sanitize({ app: 'chrome', title: '银行流水.xlsx' }).title, '', '命中了就不给标题');
  assert.equal(sanitize({ app: 'Word', title: '离职申请' }, { mute: ['离职'] }).title, '');
});

test('浏览器照常给标题：那才是「在做什么」', () => {
  const chrome = sanitize({ app: 'chrome', title: 'B站 - 又看视频' });
  assert.equal(chrome.title, 'B站 - 又看视频');
});

test('注入的那一行：带上是多久前看到的', () => {
  const s = { at: T - 3 * 60e3, app: 'Code', title: 'host.js' };
  assert.equal(screenLine(s, T), '他此刻：在 Code「host.js」（3 分钟前看到的）');
  assert.match(screenLine({ at: T - 10e3, app: 'Code', title: '' }, T), /刚刚看到的/);
});

test('五分钟外的不说——那不是「此刻」', () => {
  const s = { at: T - 6 * 60e3, app: 'Code', title: 'host.js' };
  assert.equal(screenLine(s, T), '');
  assert.equal(screenLine({ at: T, app: '', title: '' }, T), '', '没读到就什么都不说');
  assert.equal(screenLine(null, T), '');
});
