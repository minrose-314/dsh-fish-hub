// capability_route —— 唯一常驻的路由决策工具。SPEC §5.5。
// 工具定义走内核 Tool 契约（parameters 是 JSON Schema，output 必须 { schema, render }）。

export function makeRouteTool({ registry, perAgent, resolveCurrentAgent, listAgents = () => [] }) {
  const out = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
    },
    render: (_a, v) => [{ type: 'text', text: v?.text ?? '(空)' }],
  };

  return {
    name: 'capability_route',
    description:
      '小鱼的能力面路由台：查菜单、装载/卸载本轮要用的能力、看当前状态。\n' +
      'list = 全部能力菜单（含风险/成本/适用场景）；load = 把某能力请进本轮（写明 reason，' +
      '本轮结束自动卸，pin 可驻留）；unload = 提前退场；status = 当前会话的通道/信任/在场情况；' +
      'channels = 列出所有活会话的通道判定（只读调试，验收用）。\n' +
      '规则：装什么由你自己判断（reason 会进决策日志）；高风险能力（external-write/exec/admin）' +
      '只在私聊以上信任可加载；protect 名单的能力任何来源不可卸。不硬编码任务→插件映射，菜单就是全部知识。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'load', 'unload', 'pin', 'status', 'channels'],
          description: 'list|load|unload|pin|status|channels',
        },
        capability: { type: 'string', description: '能力名（load/unload/pin 必填）' },
        reason: { type: 'string', description: '为什么装卸——进决策日志，必填（list/status 可省）' },
        keep: { type: 'boolean', description: 'load 时 true = 驻留到会话结束（默认本轮结束自动卸）' },
        includeAll: { type: 'boolean', description: 'channels 时附上说明行（默认真实桥判定注释）' },
      },
      required: ['action'],
    },
    output: out,
    async execute(args) {
      const agent = resolveCurrentAgent();
      if (!agent) return { ok: false, text: '找不到当前会话的 agent 上下文（编排核心降级中）。' };
      const action = args?.action;
      const reason = String(args?.reason ?? '').slice(0, 300);
      try {
        if (action === 'list') {
          const views = registry.views(perAgent.statusOf(agent).trust);
          const lines = views.map((c) =>
            `${c.name}｜${c.risk}｜${c.kind === 'lazy' ? 'lazy' : 'live'}｜${c.health}${c.health !== 'ok' ? `(${c.purpose})` : ''}｜${c.purpose}\n  用:${c.whenToUse || '—'}\n  不用:${c.whenNotToUse || '—'}｜成本 ${JSON.stringify(c.cost)}`);
          return { ok: true, text: `能力菜单（${views.length} 条）：\n${lines.join('\n') || '（空）'}` };
        }
        if (action === 'load') {
          if (!args.capability) return { ok: false, text: 'load 需要 capability 名。' };
          if (!reason) return { ok: false, text: 'load 必须写 reason（决策日志要你的判断依据）。' };
          return perAgent.load(agent, args.capability, reason, { ephemeral: !args.keep });
        }
        if (action === 'unload') {
          if (!args.capability) return { ok: false, text: 'unload 需要 capability 名。' };
          return perAgent.unload(agent, args.capability, reason || 'unspecified');
        }
        if (action === 'pin') {
          if (!args.capability) return { ok: false, text: 'pin 需要 capability 名。' };
          const t = perAgent.pin(agent, args.capability, reason || 'unspecified');
          return { ok: typeof t === 'string' && t.includes('驻留'), text: String(t) };
        }
        if (action === 'status') {
          return { ok: true, text: JSON.stringify(perAgent.statusOf(agent), null, 1) };
        }
        if (action === 'channels') {
          const rows = [];
          for (const a of listAgents()) {
            try {
              const s = perAgent.statusOf(a);
              rows.push(`${String(a?.id ?? '?').slice(0, 24)}｜${s.channel}/${s.trust}｜resident:${s.resident.join(',') || '—'}`);
            } catch { rows.push(`${String(a?.id ?? '?').slice(0, 24)}｜判定失败(隔离)`); }
          }
          return { ok: true, text: `活会话通道判定（${rows.length}）：\n${rows.join('\n') || '（无）'}${args?.includeAll ? '' : '\n（cwd 来源：会话 meta；QQ/微信桥真实会话以各自桥目录判通道）'}` };
        }
        return { ok: false, text: `不认识的动作 "${action}"（可用 list/load/unload/pin/status/channels）。` };
      } catch (error) {
        return { ok: false, text: `路由台故障（已隔离，对话不受影响）：${String(error?.message ?? error).slice(0, 200)}` };
      }
    },
  };
}
