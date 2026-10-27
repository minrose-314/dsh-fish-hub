#!/usr/bin/env node
// check-ui.mjs —— 发布前硬闸门：把总控台页面 JS 按"浏览器真正拿到的形态"过一遍解析器。
// 为什么存在：这个项目的页面脚本嵌在 core.mjs 的模板字符串里，历史上两次线上僵死
//   ① renderFeed 多一个括号；② 内联 onclick 的 \' 在模板求值时被吞成裸引号。
//   两次都是"源码 node --check 过了、浏览器拿到的是坏 JS"——检查对象错了。
// 本脚本检查的是求值后的字节：转义地狱、引号配对、括号平衡，一次过。
// 用法：node scripts/check-ui.mjs（在插件根目录跑，或 npm run check:ui）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(root, 'hub/core.mjs'), 'utf8');
const m = src.match(/const PAGE = `([\s\S]*?)`;/);
if (!m) fail('core.mjs 里找不到 PAGE 模板（结构变了？同步改本脚本的提取正则）');

// 与运行时逐字节同义：模板字面量直接求值（PAGE 无插值，求值即还原转义）
const evaluated = eval('`' + m[1] + '`');

const script = evaluated.match(/<script>([\s\S]*)<\/script>/)?.[1];
if (!script) fail('PAGE 里找不到 <script> 段');

const tmp = path.join(os.tmpdir(), `fish-hub-check-ui-${Date.now()}.mjs`);
fs.writeFileSync(tmp, script);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (e) {
  fs.rmSync(tmp, { force: true });
  fail('求值后的页面 JS 语法不过！浏览器会整页僵死。stderr:\n' + String(e.stderr));
}
fs.rmSync(tmp, { force: true });

// 行为断言（历史 bug 的回归哨兵）：
const asserts = [
  ['不应再有内联 onclick 处理 rst/save（引号吞转义根因）', !/onclick="[^"]*(rst|save)/.test(evaluated)],
  ['必须有 [data-save],[data-rst] 事件委托', /closest\("\[data-save\],\[data-rst\]"\)/.test(evaluated)],
  ['导航按钮必须存在', /nav button/.test(evaluated)],
];
const broken = asserts.filter(([, ok]) => !ok).map(([t]) => t);
if (broken.length) fail('回归断言失败:\n  - ' + broken.join('\n  - '));

console.log(`check-ui OK — 求值后页面 JS ${script.length} 字节，语法与回归断言全过`);

function fail(msg) {
  console.error('check-ui FAIL — ' + msg);
  process.exit(1);
}
