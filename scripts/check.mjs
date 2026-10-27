#!/usr/bin/env node
// check.mjs —— 语法总闸：插件内全部 .mjs/.js 逐个过 node --check（含本目录脚本）。
// 分层容错装配救得了运行期，救不了发布物里的语法错——那要靠这一步。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const skip = new Set(['node_modules', 'data', 'backups', '.git']);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name) || e.name.endsWith('.bak') || e.name.includes('.bak-')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(mjs|js)$/.test(e.name)) files.push(p);
  }
})(root);

let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    console.error(`FAIL ${path.relative(root, f)}\n${String(e.stderr).split('\n').slice(0, 6).join('\n')}`);
  }
}
console.log(bad ? `check FAIL — ${bad}/${files.length} 个文件不过` : `check OK — ${files.length} 个 JS 文件全过语法`);
process.exit(bad ? 1 : 0);
