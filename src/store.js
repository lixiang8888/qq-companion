// 状态落盘：单个 JSON 文件，写临时文件再 rename，避免断电/崩溃留下半个文件。
// 读坏了不抛错——回到初始状态比整个插件起不来强，坏文件先改名留证。
//
// 备份节流：记忆卡每轮都写，几 MB 的文件如果每次都复制一份 .bak，
// 一次对话就是几 MB 的额外 IO。默认 5 分钟最多备一次，够挡住"写坏了"。

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const BACKUP_EVERY_MS = 5 * 60e3;

export function createJsonStore(file, { defaults = () => ({}), log = () => {}, backupEveryMs = BACKUP_EVERY_MS, now = Date.now } = {}) {
  let lastBackupAt = null;
  return {
    load() {
      try {
        if (!existsSync(file)) return defaults();
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* 留证失败就算了 */ }
        log(`状态文件读坏了，已重置：${error.message}`);
        return defaults();
      }
    },
    save(value) {
      mkdirSync(dirname(file), { recursive: true });
      // 变化即备份（节流版）：写坏/误删时还有上一版；只留一份 .bak，不堆时间戳。
      try {
        if (existsSync(file) && (lastBackupAt === null || now() - lastBackupAt >= backupEveryMs)) {
          writeFileSync(`${file}.bak`, readFileSync(file));
          lastBackupAt = now();
        }
      } catch { /* 备份失败不挡写入 */ }
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(value, null, 2));
      renameSync(tmp, file);
    },
  };
}
