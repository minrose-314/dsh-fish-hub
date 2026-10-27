// 按会话的能力面：目录状态、lazy 装卸、轮末生命周期、prompt 薄目录。
// SPEC §5.4/§5.6。注册挂 agent.ctx（practices 双主规则：核心自己留 disposer）。

export function createPerAgent({ ctx, registry, trustOf, log, logDecision, protect = [] }) {
  // agent -> { trust, channel, resident:Set, loaded:Map(name->{ephemeral,offs[]}), }
  const states = new Map();

  const ensure = (agent) => {
    let st = states.get(agent);
    if (st) return st;
    const t = trustOf(agent);
    st = {
      channel: t.channel ?? 'unknown',
      trust: t.trust ?? 'unknown',
      matched: t.matched,
      resident: new Set((t.resident ?? ['persona-memory']).filter((n) => registry.get(n))),
      loaded: new Map(),
    };
    states.set(agent, st);
    // 能力面 prompt 段（scoped 同名遮蔽全局；每次 assemble 重新求值）
    try {
      const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
          name: 'fish-soul-capabilities',
          order: 62,
          text: () => catalogText(agent, st),
          interpolate: false,
        });
      });
      ctx.effect(() => () => void fiber?.dispose?.(), `fish-soul: prompt for ${String(agent?.id)}`);
    } catch (error) {
      log(`prompt 段注册失败（不影响对话）：${String(error?.message ?? error)}`);
    }
    return st;
  };

  const catalogText = (agent, st) => {
    const onStage = [...st.resident, ...st.loaded.keys()];
    const lines = onStage
      .map((n) => registry.get(n))
      .filter(Boolean)
      .map((c) => `- ${c.name}（${c.risk}）：${c.purpose ?? ''}`);
    const menu = registry
      .views(st.trust)
      .filter((c) => !st.resident.has(c.name) && !st.loaded.has(c.name) && c.health === 'ok')
      .map((c) => `- ${c.name}（${c.risk}｜${c.kind === 'lazy' ? '可装载' : '已在场，仅需入目录'}）：${c.whenToUse || c.purpose || ''}`);
    if (lines.length === 0 && menu.length === 0) return '';
    return [
      `【能力面 · ${st.channel}/${st.trust}】本轮在场：`,
      ...(lines.length ? lines : ['  （无）']),
      `可用菜单（capability_route 按 reason 装载；高风险仅私聊以上）：`,
      ...(menu.length ? menu.slice(0, 12) : ['  （无）']),
    ].join('\n');
  };

  // ── 装载 / 卸载 ────────────────────────────────────────────────
  const trustRank = { unknown: 0, group: 1, private: 2, admin: 3 };
  const riskFloor = { read: 'unknown', 'external-write': 'private', exec: 'private', admin: 'admin' };

  function gate(agent, cap, action) {
    const st = ensure(agent);
    if (protect.includes(cap.name) && action === 'unload') {
      return { ok: false, why: 'protected', st };
    }
    if (action === 'load') {
      const need = riskFloor[cap.risk] ?? 'admin';
      if ((trustRank[st.trust] ?? 0) < (trustRank[need] ?? 3)) {
        return { ok: false, why: `blocked-by-trust(${st.trust}<${need})`, st };
      }
      if (cap.health !== 'ok') return { ok: false, why: `degraded:${cap.healthNote ?? cap.health}`, st };
    }
    return { ok: true, st };
  }

  const load = (agent, capName, reason, { ephemeral = true } = {}) => {
    const cap = registry.get(capName);
    if (!cap) return { ok: false, text: `没有叫 "${capName}" 的能力。list 看菜单。` };
    const g = gate(agent, cap, 'load');
    if (!g.ok) {
      logDecision({ action: 'load', capability: capName, reason, result: g.why, channel: g.st.channel, trust: g.st.trust, agent: String(agent?.id ?? '') });
      return { ok: false, text: `拒载 ${capName}：${g.why}` };
    }
    const st = g.st;
    if (st.resident.has(capName) || st.loaded.has(capName)) {
      return { ok: true, text: `${capName} 本来就在场。` };
    }
    if (cap.kind === 'lazy' && cap.toolDefs?.length) {
      const offs = [];
      for (const def of cap.toolDefs) {
        try {
          const off = agent.ctx.tools.register(def);
          offs.push(typeof off === 'function' ? off : () => {});
        } catch (error) {
          // 故障隔离：这条能力 degraded，其他一切照常
          registry.markHealth(capName, 'degraded', String(error?.message ?? error));
          offs.forEach((off) => { try { off(); } catch {} });
          logDecision({ action: 'load', capability: capName, reason, result: 'degraded', channel: st.channel, trust: st.trust, agent: String(agent?.id ?? '') });
          return { ok: false, text: `装载 ${capName} 失败（已隔离）：${String(error?.message ?? error).slice(0, 160)}` };
        }
      }
      st.loaded.set(capName, { ephemeral, offs, used: false });
    } else {
      st.loaded.set(capName, { ephemeral, offs: [], used: false });
    }
    logDecision({ action: 'load', capability: capName, reason, result: 'ok', ephemeral, channel: st.channel, trust: st.trust, agent: String(agent?.id ?? '') });
    return {
      ok: true,
      text: `${capName} 在场了（${cap.kind === 'lazy' ? `已注册 ${cap.entrypoints.length} 个工具` : '引用型：工具已在层里，目录已点亮'}${ephemeral ? '，本轮结束自动卸' : '，pinned'}）。入口：${cap.entrypoints.join(', ')}`,
    };
  };

  const unload = (agent, capName, reason) => {
    const st = ensure(agent);
    const cap = registry.get(capName);
    if (!cap) return { ok: false, text: `没有叫 "${capName}" 的能力。` };
    const g = gate(agent, cap, 'unload');
    if (!g.ok) {
      logDecision({ action: 'unload', capability: capName, reason, result: g.why, channel: st.channel, trust: st.trust, agent: String(agent?.id ?? '') });
      return { ok: false, text: `不许卸 ${capName}：${g.why}（protect 名单任何来源都动不了）` };
    }
    if (st.resident.has(capName)) return { ok: false, text: `${capName} 是本通道常驻（resident），不卸。` };
    const rec = st.loaded.get(capName);
    if (!rec) return { ok: true, text: `${capName} 本来不在场。` };
    for (const off of rec.offs) { try { off(); } catch {} }
    st.loaded.delete(capName);
    logDecision({ action: 'unload', capability: capName, reason, used: rec.used, channel: st.channel, trust: st.trust, agent: String(agent?.id ?? '') });
    return { ok: true, text: `${capName} 已卸。` };
  };

  const pin = (agent, capName, reason) => {
    const st = ensure(agent);
    const rec = st.loaded.get(capName);
    if (!rec) return `先 load ${capName} 才能 pin。`;
    rec.ephemeral = false;
    logDecision({ action: 'pin', capability: capName, reason, channel: st.channel, trust: st.trust, agent: String(agent?.id ?? '') });
    return `${capName} 驻留到会话结束。`;
  };

  // ── 生命周期接线 ───────────────────────────────────────────────
  ctx.on('agent/created', ({ agent }) => { ensure(agent); });
  ctx.on('agent/disposed', ({ agent }) => {
    const st = states.get(agent);
    if (st) for (const rec of st.loaded.values()) for (const off of rec.offs) { try { off(); } catch {} }
    states.delete(agent);
  });
  // 本轮结束：ephemeral 自动卸（SPEC 5.6；"这轮用完就脱手"）
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const st = states.get(agent);
    if (!st) return;
    for (const [name, rec] of [...st.loaded]) {
      if (!rec.ephemeral) continue;
      for (const off of rec.offs) { try { off(); } catch {} }
      st.loaded.delete(name);
      logDecision({ action: 'auto-unload', capability: name, used: rec.used, turn, channel: st.channel, trust: st.trust, agent: String(agent?.id ?? '') });
    }
  });
  // used 记账（尽力而为：拿得到 agent 才记）
  ctx.on('tools/result', (exec, result) => {
    try {
      const agent = exec?.agent;
      const name = exec?.name ?? exec?.tool;
      if (!agent || !name) return;
      const st = states.get(agent);
      if (!st) return;
      for (const [capName, rec] of st.loaded) {
        const cap = registry.get(capName);
        if (cap?.entrypoints?.includes(name) && !result?.error) rec.used = true;
      }
    } catch { /* 记账失败不影响执行 */ }
  });

  return {
    ensure,
    load,
    unload,
    pin,
    statusOf: (agent) => {
      const st = ensure(agent);
      return {
        channel: st.channel,
        trust: st.trust,
        matchedBy: st.matched,
        resident: [...st.resident],
        loaded: [...st.loaded].map(([n, r]) => ({ name: n, ephemeral: r.ephemeral, used: r.used })),
      };
    },
  };
}
