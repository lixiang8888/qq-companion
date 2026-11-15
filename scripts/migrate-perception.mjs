// 一次性迁移：把老记忆正文里的画面描述搬进感知记忆。
//
// 为什么：11-15 之前，图片描述是直接塞在记忆卡正文里的（每条都跟着注入上下文）。
// 现在有感知记忆了，描述该住在那儿，正文只留一句「他发了一张图」。
//
// 默认 dry-run：只说会改多少条、改哪几条。加 --write 才动文件，动之前各存一份 .bak-migrate。
//
// 用法：
//   node scripts/migrate-perception.mjs            # 看一眼
//   node scripts/migrate-perception.mjs --write    # 真改

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createIndex, sha12 } from '../src/perception/store.js';

const NOTE = /^（你看了一眼他刚发来的图：([\s\S]*?)知道就行，别复述）/;
const OLD = /^\[他发了一张图[:：]([\s\S]*?)\]/;

export function planMigration(card) {
  const out = [];
  for (const rec of card?.records || []) {
    const text = String(rec.text || '');
    const m = NOTE.exec(text) || OLD.exec(text);
    if (!m) continue;
    const desc = String(m[1] || '').replace(/\s+/g, ' ').trim();
    // 只剩标点的「描述」等于没有，别为它建一条记忆。
    if (!desc || !/[\u4e00-\u9fffA-Za-z0-9]/.test(desc)) continue;
    const rest = text.slice(m[0].length)
      .replace(/\[(图片|表情[^\]]*|视频|语音|文件|卡片|转发)\]/g, '')   // 正文里的占位标签没信息量
      .replace(/\s+/g, ' ')
      .trim();
    out.push({
      rec,
      desc,
      newText: `他发了一张图${rest}`.slice(0, 300),
      perception: {
        id: `p_${sha12(Buffer.from(desc))}`,
        sha: sha12(Buffer.from(desc)),
        at: Number(rec.createdAt) || 0,
        source: 'his',
        scene: 'chat',
        file: '',
        thumb: '',
        pixels: false,          // 老图没有原图了，只剩这句描述
        w: null,
        h: null,
        bytes: 0,
        mime: '',
        frames: 1,
        title: desc.slice(0, 30),
        desc: desc.slice(0, 400),
        slots: { who: [], what: [], where: [], action: [], look: [] },
        feel: rec.feel || null,
        heat: Number.isFinite(rec.heat) ? rec.heat : null,
        memoryId: rec.id,
        hits: 0,
        lastHitAt: 0,
        vec: null,
      },
    });
  }
  return out;
}

function main() {
  const write = process.argv.includes('--write');
  const dataDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins-data', 'qq-companion');
  const memFile = join(dataDir, 'memory.json');
  const percFile = join(dataDir, 'perception.json');
  if (!existsSync(memFile)) {
    console.error(`找不到 ${memFile}`);
    process.exit(1);
  }
  const card = JSON.parse(readFileSync(memFile, 'utf8'));
  const planned = planMigration(card);

  console.log(`记忆卡共 ${(card.records || []).length} 条，需要迁移的 ${planned.length} 条`);
  for (const p of planned.slice(0, 5)) console.log(`  · ${p.rec.id} → ${p.newText.slice(0, 40)}`);
  if (planned.length > 5) console.log(`  …还有 ${planned.length - 5} 条`);

  if (!write) {
    console.log('\n这是 dry-run，什么都没改。确认无误后加 --write 再跑一次。');
    return;
  }

  // 先备份，再写。写坏了好退回来。
  copyFileSync(memFile, `${memFile}.bak-migrate`);
  if (existsSync(percFile)) copyFileSync(percFile, `${percFile}.bak-migrate`);

  const index = existsSync(percFile) ? JSON.parse(readFileSync(percFile, 'utf8')) : createIndex();
  const seen = new Set((index.records || []).map((r) => r.sha));
  for (const p of planned) {
    if (seen.has(p.perception.sha)) continue;
    seen.add(p.perception.sha);
    index.records = [...(index.records || []), p.perception];
    p.rec.text = p.newText;
  }
  writeFileSync(percFile, JSON.stringify(index, null, 2));
  writeFileSync(memFile, JSON.stringify(card, null, 2));
  console.log(`\n已写入：感知记忆 ${index.records.length} 条，记忆卡正文 ${planned.length} 条已换成 gist。`);
  console.log('备份：memory.json.bak-migrate / perception.json.bak-migrate');
}

if (process.argv[1] && process.argv[1].endsWith('migrate-perception.mjs')) main();
