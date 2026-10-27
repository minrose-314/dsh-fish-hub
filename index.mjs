// dsh-fish-hub v0.1 —— 小鱼大插件：能力路由(fish-soul) + 微信直发(fish-bridge) + 多端账本与总控台(hub)
// 三合一入口：依次装配三层，各自的 dispose 自理；任何一层失败不拖垮其余层。
import { apply as soulApply } from './soul/index.js';
import { apply as bridgeApply } from './bridge/index.js';
import { startCore, createTools } from './hub/core.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIAG = path.join(os.homedir(), '.dsh', 'fish-hub-diag.log');
const diag = (line) => { try { fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${line}\n`); } catch {} };

export const inject = ['tools', 'agents'];

export function apply(ctx, config = {}) {
  diag('apply called v0.1');
  const layers = [];
  try { soulApply(ctx, config.soul || {}); layers.push('soul'); }
  catch (e) { diag(`soul 层失败: ${e?.stack || e}`); }
  try { bridgeApply(ctx, config.bridge || {}); layers.push('bridge'); }
  catch (e) { diag(`bridge 层失败: ${e?.stack || e}`); }
  let core = null;
  try { core = startCore(config.hub || {}); layers.push('hub'); }
  catch (e) { diag(`hub 层失败: ${e?.stack || e}`); }
  try {
    for (const t of createTools()) {
      const off = ctx.tools.register(t);
      if (typeof off === 'function') ctx.on('dispose', off);
    }
    layers.push('hub-tools');
  } catch (e) { diag(`hub 工具注册失败: ${e?.stack || e}`); }
  ctx.on('dispose', () => { try { core && core.stop(); } catch {} });
  diag('装配完成: ' + layers.join('+'));
  return { layers, get core() { return core; } };
}
