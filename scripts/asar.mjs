// 读 Electron app.asar 里的文件（只读）。
// 用途：DSH 的核心包源码在 asar 里，插件 API 只能从那里确认，不能靠猜。
//
// 用法：
//   node scripts/asar.mjs list  <asar> [前缀]         列出路径
//   node scripts/asar.mjs cat   <asar> <路径>         打印文件内容
//   node scripts/asar.mjs save  <asar> <路径> <输出>  存到磁盘

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function open(file) {
  const buf = readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
  const base = 8 + buf.readUInt32LE(4);
  const entries = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, p);
      else entries.push({ path: p, offset: Number(child.offset), size: child.size });
    }
  };
  walk(header, '');
  return { buf, base, entries };
}

const [cmd, asar, arg1, arg2] = process.argv.slice(2);
if (!cmd || !asar) {
  console.error('用法: list <asar> [前缀] | cat <asar> <路径> | save <asar> <路径> <输出>');
  process.exit(2);
}
const { buf, base, entries } = open(asar);

if (cmd === 'list') {
  for (const e of entries.filter((x) => !arg1 || x.path.startsWith(arg1)).sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(`${String(e.size).padStart(9)}  ${e.path}`);
  }
} else if (cmd === 'cat' || cmd === 'save') {
  const e = entries.find((x) => x.path === arg1);
  if (!e) { console.error(`没有这个文件：${arg1}`); process.exit(1); }
  const data = buf.subarray(base + e.offset, base + e.offset + e.size);
  if (cmd === 'cat') process.stdout.write(data);
  else {
    mkdirSync(dirname(arg2), { recursive: true });
    writeFileSync(arg2, data);
    console.log(`${arg2}  ${e.size} bytes`);
  }
} else {
  console.error(`未知命令：${cmd}`);
  process.exit(2);
}
