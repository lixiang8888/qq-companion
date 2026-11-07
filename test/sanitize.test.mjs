// 脱敏：密钥、凭证、手机号、证件号不跟着记忆进提示词。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSecrets } from '../src/memory/sanitize.js';

test('常见密钥形态被替换', () => {
  const cases = [
    'sk-abcdefgh12345678',
    'ghp_aaaaaaaaaaaaaaaaaaaa',
    'github_pat_11ABCDEFG_abcdefghij',
    'AKIAIOSFODNN7EXAMPLE',
    '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',
    'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
  ];
  for (const c of cases) {
    const out = sanitizeSecrets(`我的 key 是 ${c} 别告诉别人`);
    assert.ok(!out.includes(c), `没脱敏：${c} → ${out}`);
  }
});

test('key=value 形态只隐藏值', () => {
  const out = sanitizeSecrets('token=abc123 password: hunter2');
  assert.match(out, /token=\[已隐藏\]/);
  assert.match(out, /password:\[已隐藏\]/);
  assert.ok(!out.includes('hunter2'));
});

test('手机号与证件号被替换', () => {
  const out = sanitizeSecrets('我手机 13812345678，身份证 11010519491231002X');
  assert.ok(!out.includes('13812345678'));
  assert.ok(!out.includes('11010519491231002X'));
});

test('普通聊天不被误伤', () => {
  const s = '今天加班到十点，累死了，想吃火锅';
  assert.equal(sanitizeSecrets(s), s);
});
