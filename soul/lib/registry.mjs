// 能力注册表。SPEC §5.2/§5.3/§5.6。
// 两条入册路径，核心都不需要知道辅助插件是谁：
//   1) 辅助插件 apply 时 capabilities.register(manifest)（带工具定义 = lazy 可装卸）
//   2) 核心 config.declarations 被动登记（引用全局已有工具 = live，只控目录不控注册）
// 任何一个坏掉只影响它自己那条能力：标记 degraded，注册表照常工作。

export function createRegistry({ initialDeclarations = [], log = () => {} } = {}) {
  // name -> capability view
  const caps = new Map();

  const put = (cap) => {
    caps.set(cap.name, cap);
  };

  // ── 被动声明（live） ──────────────────────────────────────────────
  for (const decl of initialDeclarations) {
    try {
      for (const c of decl?.capabilities ?? []) {
        put({
          ...c,
          plugin: decl.plugin ?? 'declared',
          pluginVersion: decl.version ?? 'n/a',
          kind: 'live', // 工具本来就在某个层注册着：load=入目录，不做装卸
          source: 'declaration',
          health: 'ok',
        });
      }
    } catch (error) {
      log(`declaration 解析失败（跳过该条，不影响其他）：${String(error?.message ?? error)}`);
    }
  }

  return {
    /** 辅助插件的主动注册入口。tools 为 [{ definition }] 时该能力是 lazy：
     *  核心在 load 时把它 register 到目标 agent.ctx，unload 即 dispose。 */
    register(manifest) {
      const names = [];
      try {
        const list = manifest?.capabilities ?? [];
        for (const c of list) {
          if (!c?.name || !Array.isArray(c.entrypoints)) {
            log(`manifest 能力缺 name/entrypoints，跳过`);
            continue;
          }
          put({
            ...c,
            plugin: manifest?.plugin ?? 'unknown',
            pluginVersion: manifest?.version ?? 'n/a',
            kind: c.tools?.length ? 'lazy' : 'live',
            toolDefs: (c.tools ?? []).map((t) => t?.definition).filter(Boolean),
            source: 'plugin',
            health: 'ok',
          });
          names.push(c.name);
        }
      } catch (error) {
        log(`register 失败（隔离，不影响核心）：${String(error?.message ?? error)}`);
        return () => {};
      }
      return () => {
        for (const n of names) {
          const c = caps.get(n);
          if (c?.source === 'plugin') caps.delete(n);
        }
      };
    },

    unregister(name) {
      caps.delete(name);
    },

    markHealth(name, health, note) {
      const c = caps.get(name);
      if (c) {
        c.health = health;
        c.healthNote = note ?? '';
      }
    },

    get(name) {
      return caps.get(name);
    },

    list() {
      return [...caps.values()];
    },

    views(trust) {
      return this.list().map((c) => ({
        name: c.name,
        plugin: c.plugin,
        purpose: c.purpose ?? '',
        whenToUse: c.whenToUse ?? '',
        whenNotToUse: c.whenNotToUse ?? '',
        risk: c.risk ?? 'read',
        cost: c.cost ?? {},
        kind: c.kind,
        health: c.health,
        entrypoints: c.entrypoints ?? [],
      }));
    },
  };
}
