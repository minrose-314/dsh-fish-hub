// 决策日志：每轮"想了什么→装了什么→用没用"落本地 jsonl。
// SPEC §5.7 —— 不进 session 事件流（practices 红线），派生数据 30 天轮转。

import fs from 'node:fs';
import path from 'node:path';

const dayStamp = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');

export function createDecisionLog(dataDir) {
  const dir = path.join(dataDir, 'logs');
  let lastCleanupDay = '';

  const cleanup = (today) => {
    if (today === lastCleanupDay) return;
    lastCleanupDay = today;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const cutoff = Date.now() - 30 * 86400_000;
      for (const f of fs.readdirSync(dir)) {
        if (!/^decisions-\d{8}\.jsonl$/.test(f)) continue;
        const full = path.join(dir, f);
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
      }
    } catch { /* 日志尽力而为，绝不打断对话链路 */ }
  };

  return (record) => {
    try {
      const today = dayStamp();
      cleanup(today);
      fs.appendFileSync(
        path.join(dir, `decisions-${today}.jsonl`),
        JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n',
      );
    } catch { /* 同上 */ }
  };
}
