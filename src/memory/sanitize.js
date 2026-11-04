// 入库前脱敏：记忆会被拼进提示词，密钥/凭证不该跟着进去。
//
// 模式取自 dsh-memory-core 的 sanitize（MIT），只留我们真正会遇到的几类；
// 替换成同样长度的占位，避免把「有没有密码」当成信息泄露出去。

const RULES = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[密钥已隐藏]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/g, '[令牌已隐藏]'],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, '[令牌已隐藏]'],
  [/\bAKIA[0-9A-Z]{12,}/g, '[密钥已隐藏]'],
  [/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [令牌已隐藏]'],
  [/\b(?:password|passwd|token|api[_-]?key|secret)\s*[=:]\s*\S+/gi, (m) => m.replace(/([=:]).*$/, '$1[已隐藏]')],
  [/\b1[3-9]\d{9}\b/g, '[手机号已隐藏]'],
  [/\b\d{17}[\dXx]\b/g, '[证件号已隐藏]'],
];

export function sanitizeSecrets(text) {
  let out = String(text ?? '');
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}
