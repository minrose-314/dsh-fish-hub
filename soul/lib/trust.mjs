// 信任解析：会话 → { channel, trust }。SPEC §1/§4.4。
// 输入是会话 cwd 前缀（通道桥都固定在各自目录起会话）；读不到就 unknown，
// 一切高风险操作按最低信任处理——安全侧默认。

const norm = (p) => String(p ?? '').replaceAll('\\', '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase();

export function createTrustResolver(channels) {
  const list = Array.isArray(channels) ? channels : [];
  // 兜底通道（没 cwd match 的那条）放最后
  const ordered = [...list].sort((a, b) => {
    const aw = a?.match?.cwd?.length ? 0 : 1;
    const bw = b?.match?.cwd?.length ? 0 : 1;
    return aw - bw;
  });

  return function resolveTrusted(agent) {
    let cwd = '';
    try {
      cwd = agent?.session?.meta?.cwd
        ?? agent?.session?.header?.cwd
        ?? agent?.cwd
        ?? '';
    } catch { cwd = ''; }
    const n = norm(cwd);
    let fallback = null;
    for (const ch of ordered) {
      const prefixes = ch?.match?.cwd;
      if (!Array.isArray(prefixes) || prefixes.length === 0) {
        fallback = fallback ?? ch; // 无 match 的声明只当兜底，最后才用
        continue;
      }
      if (prefixes.some((p) => n.startsWith(norm(p)))) {
        return { ...ch, cwd: n, matched: 'cwd' };
      }
    }
    if (fallback) return { ...fallback, cwd: n, matched: 'fallback' };
    return { channel: 'unknown', trust: 'unknown', resident: ['persona-memory'], cwd: n, matched: 'none' };
  };
}

// 信任等级数值化（比较用）。等级语义写死，config 只管显示。
export const TRUST_RANK = { unknown: 0, group: 1, private: 2, admin: 3 };
export const RISK_RANK = { read: 0, 'external-write': 1, exec: 2, admin: 3 };

export const atLeast = (table, have, need) => (table[have] ?? 0) >= (table[need] ?? 0);

// 风险 → 最低信任要求（红线，不可被对话内容改变）
export const MIN_TRUST_FOR_RISK = {
  read: 'unknown',        // 只读菜单级：所有来源可见（QQ 群查余额这种也靠它，但工具本身不在场就没了）
  'external-write': 'private',
  exec: 'private',
  admin: 'admin',
};
