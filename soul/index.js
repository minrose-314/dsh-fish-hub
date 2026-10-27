// dsh-fish-soul v0.1 —— 核心编排插件（Capability Orchestrator）
//
// 架构原则（SPEC §0）：薄反射弧，不是上帝插件。本文件不 import 任何辅助插件——
// 能力经公开服务契约 `capabilities` 注册进来，或经 config.declarations 被动声明。
// 辅助插件缺失/报错时本核心照常启动并降级（每条能力独立健康状态）。
//
// 决策权归 Agent（capability_route 的 reason 由模型自己写），
// 执行权归核心（register/dispose/trust 门），安全红线写死不可被对话内容改变。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDecisionLog } from './lib/decisions.mjs';
import { createTrustResolver } from './lib/trust.mjs';
import { createRegistry } from './lib/registry.mjs';
import { createPerAgent } from './lib/per-agent.mjs';
import { makeRouteTool } from './lib/route-tool.mjs';

export const inject = ['tools', 'agents'];

const DIAG = path.join(os.homedir(), '.dsh', 'fish-soul-diag.log');
const diag = (line) => {
  try {
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* 尽力而为 */ }
};

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir || path.join(os.homedir(), '.dsh', 'fish-soul');
  const logDecision = createDecisionLog(dataDir);
  const log = (m) => diag(m);

  const trustOf = createTrustResolver(config.channels);
  const registry = createRegistry({
    initialDeclarations: config.declarations ?? [],
    log,
  });
  const perAgent = createPerAgent({
    ctx,
    registry,
    trustOf,
    log,
    logDecision,
    protect: config.protect ?? [],
  });

  // 公开服务契约：辅助插件在自己 apply 里 ctx.inject(['capabilities'], s => s.capabilities.register(...))
  const face = {
    register: (manifest) => registry.register(manifest),
    unregister: (name) => registry.unregister(name),
    list: () => registry.list().map(({ toolDefs, source, ...v }) => v),
    load: (agent, name, reason, opts) => perAgent.load(agent, name, reason, opts),
    unload: (agent, name, reason) => perAgent.unload(agent, name, reason),
    statusOf: (agent) => perAgent.statusOf(agent),
    version: '0.1.0',
  };
  try {
    ctx.provide('capabilities', face);
  } catch (error) {
    log(`provide capabilities 失败（菜单仍可用，主动注册降级）：${String(error?.message ?? error)}`);
  }

  // 常驻路由工具：当前 agent 只认内核 initiator 链。
  // 绝不 fallback 到 list() 挑最近的——那会让 A 会话的指令操到 B 会话的权限上。
  const resolveCurrentAgent = () => {
    try {
      return ctx.agents.currentInitiator();
    } catch {
      return undefined;
    }
  };
  try {
    const off = ctx.tools.register(makeRouteTool({
      registry,
      perAgent,
      resolveCurrentAgent,
      listAgents: () => { try { return ctx.agents.list(); } catch { return []; } },
    }));
    if (typeof off === 'function') ctx.on('dispose', () => { try { off(); } catch {} });
    log('fish-soul apply ok: route tool registered');
  } catch (error) {
    log(`capability_route 注册失败（核心仍启动，路由不可用=完全降级）：${String(error?.message ?? error)}`);
  }

  // 给已经活着的 agent 补建状态（HMR/晚挂载场景）
  try {
    for (const agent of ctx.agents.list()) perAgent.ensure(agent);
  } catch { /* 忽略 */ }

  logDecision({ action: 'boot', result: 'ok', declarations: registry.list().length, channels: (config.channels ?? []).length });
}
