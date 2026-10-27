// fish-hub 内核 —— 多端统一账本 + 唯一控制台 + 装卸与重启（大插件 dsh-fish-hub 的 hub 层）
// 只读观察两边桥的日志/状态；写配置只碰白名单键；插件装卸只碰装饰类名单；全程备份+审计。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const HOME = os.homedir().replace(/\\/g, "/");
const PKG = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/(\w:)/, '$1')).replace(/\\/g, '/').replace(/\/hub$/, "");
const DATA = PKG + "/data";
const LEDGER = DATA + "/events.jsonl";
const CURSORS = DATA + "/cursors.json";
const BACKUP_DIR = PKG + "/backups";
const AUDIT = PKG + "/audit.log";

const QQ_CFG = HOME + "/qq-bridge/config.json";
const QQ_ACTIVITY = HOME + "/qq-bridge/state/qq-activity.log";
const QQ_BRIDGE_LOG = HOME + "/qq-bridge/state/bridge.log";
const QQ_WAKE_STATE = HOME + "/qq-bridge/state/social-v2.json";
const WX_ROOT = process.env.FISH_HUB_WX_ROOT || "D:/WeChatAgent/data/workspace";
const WX_MESSAGES = WX_ROOT + "/state/social-messages.json";
const WX_DECISIONS = WX_ROOT + "/state/logs/bridge.stdout.log";
const WX_CONFIG = WX_ROOT + "/config/wechatagent.json";
const WX_ROLES = WX_ROOT + "/roles";
const PATCH_YML = HOME + "/.dsh/profiles/desktop/cordis.patch.yml";

const SCHEMA = {
  qq: {
    "social.enabled": "bool", "social.triggerProbability": "num01", "social.mustReplyKeywords": "arr",
    "social.contextWindow": "int", "social.maxReplyChars": "int", "social.proactiveEnabled": "bool",
    "social.proactiveProbability": "num01", "social.proactiveIdleThresholdMs": "int",
    "social.proactiveCheckMinMs": "int", "social.proactiveCheckMaxMs": "int",
    "social.skipProbability": "num01", "social.surrenderProbability": "num01", "social.burstEnabled": "bool",
    "social.burstIntervalMinMs": "int", "social.burstIntervalMaxMs": "int",
    "social.longGapProbability": "num01", "social.longGapMinMs": "int", "social.longGapMaxMs": "int",
    "social.activeReplyDelayMinMs": "int", "social.activeReplyDelayMaxMs": "int",
    "social.activeCheckMinMs": "int", "social.activeCheckMaxMs": "int",
    "social.idleWindowMs": "int", "social.idleRetryProbability": "num01", "social.idleRetryWaitMs": "int",
    "socialV2.enabled": "bool", "socialV2.agentPreset": "strq", "socialV2.autoReplyCheckMs": "int",
    "socialV2.provideRecommendations": "bool", "sendDelayMs": "int",
  },
  wechat: {
    "persona.default": "str", "wechat.wake_mode": "enum:all,mention,hybrid",
    "stickers.enabled": "bool", "stickers.collectEnabled": "bool", "stickers.shareEnabled": "bool",
    "search.enabled": "bool", "proactive.enabled": "bool", "memberMemory.enabled": "bool", "history.enabled": "bool",
  },
};
const DYNAMIC = {
  qq: [{ prefix: "socialV2.tools.", type: "bool", mustExist: true }],
  wechat: [
    { prefix: "workModes.", type: "enum:assistant,social", mustExist: true },
    { prefix: "stickers.chats.", type: "bool" },
    { prefix: "persona.chats.", type: "str" },
  ],
};
// 插件装卸白名单：只有这些装饰/历史类可以一键开关；其余一律拒绝（要动找我换代）
const TOGGLEABLE = new Set([
  "ui-skin-claude-style", "web-ui-pet", "dsh-whale-widget",
  "wallpaper-engine", "wallpaper-engine-about-notice", "wallpaper-engine-mascot-avatar",
  "wallpaper-engine-media-bridge", "wallpaper-engine-pet-link", "wallpaper-engine-fx",
  "wallpaper-engine-parallax", "wallpaper-engine-fonts",
  "xmanrui-dsh-im", "web-ui-remote-web-ui", "web-ui-session-archive",
]);

// ---------- 基础工具 ----------
function readJson(f) { return JSON.parse(fs.readFileSync(f, "utf8")); }
function backup(f) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = path.basename(f);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(f, path.join(BACKUP_DIR, `${ts}--${name}`));
  const all = fs.readdirSync(BACKUP_DIR).filter(x => x.endsWith("--" + name)).sort();
  while (all.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, all.shift()));
}
function audit(msg) {
  try { fs.mkdirSync(PKG, { recursive: true }); fs.appendFileSync(AUDIT, new Date().toISOString() + "  " + msg + "\n"); } catch {}
}
function getPath(obj, dotted) { return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, dotted, val) {
  const ks = dotted.split("."); let cur = obj;
  for (let i = 0; i < ks.length - 1; i++) { if (cur[ks[i]] == null) cur[ks[i]] = {}; cur = cur[ks[i]]; }
  cur[ks[ks.length - 1]] = val;
}
function checkType(v, t) {
  if (t === "bool") return typeof v === "boolean";
  if (t === "int") return Number.isInteger(v) && v >= 0 && v <= 86400000;
  if (t === "num01") return typeof v === "number" && v >= 0 && v <= 1;
  if (t === "arr") return Array.isArray(v) && v.every(x => typeof x === "string") && v.length <= 50;
  if (t === "str") return typeof v === "string" && v.length <= 200;
  if (t === "strq") return typeof v === "string" && /^qq-[a-z0-9-]{1,40}$/.test(v);
  if (t.startsWith("enum:")) return t.slice(5).split(",").includes(String(v));
  return false;
}
function editType(section, dotted, cfgObj) {
  const s = SCHEMA[section];
  if (s[dotted]) return s[dotted];
  for (const d of (DYNAMIC[section] || [])) {
    if (dotted.startsWith(d.prefix)) {
      const key = p2key(dotted, d.prefix);
      if (d.mustExist && getPath(cfgObj, dotted) === undefined) return null;
      if (!key) return null;
      return d.type;
    }
  }
  return null;
}
function p2key(dotted, prefix) { const k = dotted.slice(prefix.length); return k && !k.includes("..") ? k : null; }

// ---------- patch.yml ----------
function parsePatch() {
  const lines = fs.readFileSync(PATCH_YML, "utf8").split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- id:\s*(.+)$/);
    if (!m) continue;
    const id = m[1].trim().replace(/^['"]|['"]$/g, "");
    let name = "", disabled = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^-\s/.test(lines[j])) break;
      const nm = lines[j].match(/^  name:\s*(.+)$/); if (nm) name = nm[1].trim().replace(/^['"]|['"]$/g, "");
      if (/^  disabled:\s*true/.test(lines[j])) disabled = true;
    }
    entries.push({ id, name, disabled, line: i });
  }
  return entries;
}
function togglePatchEntry(id, disabledWanted) {
  if (!TOGGLEABLE.has(id)) throw new Error("这个条目不在可装卸名单（动它要换代时跟我说）: " + id);
  const lines = fs.readFileSync(PATCH_YML, "utf8").split(/\r?\n/);
  const entries = parsePatch();
  const e = entries.find(x => x.id === id);
  if (!e) throw new Error("补丁里没有这个条目: " + id);
  let end = lines.length;
  for (let j = e.line + 1; j < lines.length; j++) { if (/^-\s/.test(lines[j])) { end = j; break; } }
  const block = lines.slice(e.line, end);
  const di = block.findIndex(l => /^  disabled:\s*/.test(l));
  if (disabledWanted) {
    if (di >= 0 && /true/.test(block[di])) return false;
    if (di >= 0) block[di] = "  disabled: true"; else block.splice(1, 0, "  disabled: true");
  } else {
    if (di < 0) return false;
    block.splice(di, 1);
  }
  lines.splice(e.line, end - e.line, ...block);
  backup(PATCH_YML);
  fs.writeFileSync(PATCH_YML, lines.join("\n"), "utf8");
  return true;
}

// ---------- 统一账本 ----------
let events = [];
const seenIds = new Set();
let uid = Date.now();
const mkId = () => "e" + (uid++).toString(36);
function appendEvents(list) {
  if (!list.length) return;
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(LEDGER, list.map(e => JSON.stringify(e) + "\n").join(""));
  for (const e of list) { events.push(e); if (e.mid) seenIds.add(e.mid); }
  if (events.length > 20000) events.splice(0, events.length - 20000);
}
function loadLedger() {
  if (!fs.existsSync(LEDGER)) return;
  for (const l of fs.readFileSync(LEDGER, "utf8").trim().split(/\r?\n/).slice(-20000)) {
    try { const e = JSON.parse(l); events.push(e); if (e.mid) seenIds.add(e.mid); } catch {}
  }
}
let cursors = {};
try { cursors = JSON.parse(fs.readFileSync(CURSORS, "utf8")); } catch {}
function saveCursors() { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CURSORS, JSON.stringify(cursors)); } catch {} }
function tailFile(file, key, handler) {
  let st; try { st = fs.statSync(file); } catch { return; }
  let off = cursors[key];
  if (off === undefined || st.size < off) off = key === "wxdec" ? st.size : 0;
  if (st.size === off) return;
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(st.size - off);
  fs.readSync(fd, buf, 0, buf.length, off);
  fs.closeSync(fd);
  cursors[key] = st.size;
  for (const line of buf.toString("utf8").split(/\r?\n/)) if (line.trim()) handler(line);
}
function dayTs(h, mi, s) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +h, +mi, +s);
  if (d.getTime() - now.getTime() > 12 * 3600e3) d.setDate(d.getDate() - 1);
  return d.getTime();
}
function parseQQActivity(line) {
  const m = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]\s+(\S+)\s+(?:\[\w+\]\s*)?(消息已入未读|已发送|发送成功)：(.*)$/);
  if (!m) return null;
  const dir = m[3 - 1] === "消息已入未读" ? "in" : "out";
  return { ts: dayTs(m[1], m[2], m[3] ? m[2 + 1] : 0), chan: "qq", dir, conv: m[4], sender: dir === "in" ? "" : "小鱼", text: m[6].slice(0, 400) };
}
function parseWXMessages() {
  let j; try { j = JSON.parse(fs.readFileSync(WX_MESSAGES, "utf8")); } catch { return; }
  const out = [];
  for (const [conv, msgs] of Object.entries(j.chats || {})) {
    for (const msg of msgs) {
      if (!msg.id || seenIds.has(msg.id)) continue;
      out.push({
        id: mkId(), mid: msg.id, ts: (msg.timestamp || 0) * 1000, chan: "wechat",
        dir: msg.outgoing ? "out" : "in", conv, convName: msg.conversation_name || conv,
        sender: msg.outgoing ? "小鱼" : (msg.sender_name || ""),
        text: String(msg.text || (msg.images && msg.images.length ? "[图片]" : "")).slice(0, 400),
      });
    }
  }
  appendEvents(out);
}
function parseWXDecision(line) {
  const ts = Date.parse(line.slice(0, 25));
  if (isNaN(ts)) return null;
  let m = line.match(/\[Social\]\s+(\S+)\s+decision=(\w+)(?:\s+decision_ms=(\d+))?/);
  if (m) return { ts, chan: "wechat", dir: "op", conv: m[1], sender: "决策", text: m[2] + (m[3] ? ` (${m[3]}ms)` : "") };
  m = line.match(/\[Social\]\s+(\S+)\s+delivery=(\w+)\s+part=(\d+)/);
  if (m) return { ts, chan: "wechat", dir: "op", conv: m[1], sender: "投递", text: m[2] + " part" + m[3] };
  m = line.match(/\[Social\]\s+(\S+)\s+cooldown\s+wait_ms=(\d+)\s+reason=(\w+)/);
  if (m) return { ts, chan: "wechat", dir: "op", conv: m[1], sender: "冷却", text: Math.round(m[2] / 1000) + "s " + m[3] };
  return null;
}
function tick() {
  const batch = [];
  tailFile(QQ_ACTIVITY, "qqact", (line) => {
    const m = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]\s+(\S+)\s+(?:\[\w+\]\s*)?(消息已入未读|已发送|发送成功)：(.*)$/);
    if (!m) return;
    const dir = m[5] === "消息已入未读" ? "in" : "out";
    batch.push({ id: mkId(), ts: dayTs(m[1], m[2], m[3]), chan: "qq", dir, conv: m[4], sender: dir === "in" ? "" : "小鱼", text: m[6].slice(0, 400) });
  });
  tailFile(WX_DECISIONS, "wxdec", (line) => { const e = parseWXDecision(line); if (e) batch.push(Object.assign({ id: mkId() }, e)); });
  tailFile(QQ_BRIDGE_LOG, "qqblog", (line) => {
    let m = line.match(/^(\d{2}):(\d{2}):(\d{2})\s+\[bridge\]\s+\[\w+\]\s+工具统一发送\s+(\S+):\s*成功\s+(\d+)\/(\d+)\s*条/);
    if (m) { batch.push({ id: mkId(), ts: dayTs(m[1], m[2], m[3]), chan: "qq", dir: "out", conv: m[4], sender: "小鱼", text: `发送成功 ${m[5]}/${m[6]} 条` }); return; }
    m = line.match(/^(\d{2}):(\d{2}):(\d{2})\s+\[bridge\]\s+\[\w+\]\s+计划唤醒\s+(\S+?)（(.+?)）/);
    if (m) batch.push({ id: mkId(), ts: dayTs(m[1], m[2], m[3]), chan: "qq", dir: "op", conv: m[4], sender: "唤醒", text: m[5] });
  });
  appendEvents(batch);
  parseWXMessages();
  saveCursors();
}

// ---------- 汇总 ----------
function chats() {
  const map = {};
  for (const e of events) {
    const k = e.chan + "|" + e.conv;
    if (!map[k]) map[k] = { chan: e.chan, conv: e.conv, convName: e.convName || e.conv, count: 0, last: 0, lastText: "" };
    const c = map[k]; c.count++;
    if (e.ts >= c.last && e.dir !== "op") { c.last = e.ts; c.lastText = (e.sender ? e.sender + "：" : "") + (e.text || "").slice(0, 60); }
    if (e.convName) c.convName = e.convName;
  }
  return Object.values(map).sort((a, b) => b.last - a.last);
}
function queryEvents({ chan = "", convF = "", q = "", limit = 100, withOp = true } = {}) {
  let list = events.filter(e =>
    (!chan || e.chan === chan) && (!convF || e.conv === convF) &&
    (withOp || e.dir !== "op") &&
    (!q || (e.text || "").toLowerCase().includes(q) || (e.sender || "").toLowerCase().includes(q)));
  return list.slice(-Math.min(limit, 500)).reverse();
}
async function tcpAlive(port, ms = 500) {
  const net = await import("node:net");
  return new Promise(res => {
    const s = net.connect({ host: "127.0.0.1", port });
    const t = setTimeout(() => { s.destroy(); res(false); }, ms);
    s.on("connect", () => { clearTimeout(t); s.destroy(); res(true); });
    s.on("error", () => { clearTimeout(t); res(false); });
  });
}
async function chanMap() {
  const r = { ts: Date.now() };
  try {
    const qq = readJson(QQ_CFG);
    r.qq = { socialV2: !!qq.socialV2?.enabled, preset: qq.socialV2?.agentPreset, social: !!qq.social?.enabled, selfName: qq.selfDisplayName };
  } catch (e) { r.qq = { error: e.message }; }
  try {
    let wake = {};
    try { wake = readJson(QQ_WAKE_STATE).conversations || {}; } catch {}
    r.qq.wake = Object.entries(wake).map(([k, v]) => ({ conv: k, mode: v.wakeConfig?.mode, prob: v.wakeConfig?.triggers?.probability, wakeCount: v.wakeConfig?.wakeCount }));
  } catch {}
  try {
    const wx = readJson(WX_CONFIG);
    r.wechat = { wake_mode: wx.wechat?.wake_mode, workModes: wx.wechat?.workModes, stickers: wx.stickers?.enabled, memberMemory: wx.memberMemory?.enabled };
  } catch (e) { r.wechat = { error: e.message }; }
  const wxob = await onebotBand();
  r.health = { qqBridge: await tcpAlive(3100), dsh: await tcpAlive(dshPort()), wxOnebot: wxob, wxHook: await tcpAlive(30001) };
  return r;
}
// WeChatAgent 网关端口占用时会自增（实测 11229→11230），探 config 基准起的三个连号
async function onebotBand() {
  let base = 11229;
  try { base = readJson(WX_CONFIG).ports?.onebot || 11229; } catch {}
  for (const p of [base, base + 1, base + 2]) if (await tcpAlive(p)) return true;
  return false;
}
function dshPort() {
  try {
    const p = new URL(readJson(QQ_CFG).dsh?.baseUrl || "http://127.0.0.1:1581").port;
    return +p || 1581;
  } catch { return 1581; }
}

// ---------- 重启 ----------
async function restartQQ() {
  const { stdout } = await execFileP("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PKG + "/ops/restart-qq-detached.ps1"]);
  audit("重启QQ桥: " + stdout.trim()); return stdout.trim();
}
async function restartWx() {
  const { stdout } = await execFileP("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PKG + "/ops/restart-wechatagent-detached.ps1"]);
  audit("重启WeChatAgent: " + stdout.trim()); return stdout.trim();
}

// ---------- 写配置 ----------
function applyPatch(section, patch) {
  const file = section === "qq" ? QQ_CFG : WX_CONFIG;
  const cfg = readJson(file);
  const errs = [], applied = [];
  for (const [p, v] of Object.entries(patch || {})) {
    const t = editType(section, p, cfg);
    if (!t) { errs.push("不在白名单: " + p); continue; }
    if (!checkType(v, t)) { errs.push("类型不对: " + p + " 要 " + t); continue; }
    if (JSON.stringify(getPath(cfg, p)) === JSON.stringify(v)) continue;
    setPath(cfg, p, v); applied.push(p);
  }
  if (applied.length) { backup(file); fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf8"); }
  audit(`写${section === "qq" ? "QQ桥" : "微信"}配置: ${applied.join(", ") || "(无变化)"}${errs.length ? " 拒:" + errs.join(";") : ""}`);
  return { ok: errs.length === 0, applied, errors: errs };
}

// ---------- 工具（注册进 fish-soul 能力面） ----------
const textOutput = {
  schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" }, text: { type: "string" } } },
  render: (_a, v) => [{ type: "text", text: v?.text ?? "(空)" }],
};
export function createTools() {
  return [
    {
      name: "fish_hub_events",
      description:
        "查多端统一账本里的消息：QQ 和微信的来言去语都在一处（含时间）。" +
        "适合：爸在某个端问“我刚才在另一边说了啥/那群现在啥情况”，或要跨端回顾上下文。只读。",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          channel: { type: "string", description: "qq 或 wechat；不传=两边都要。" },
          conv: { type: "string", description: "可选：具体会话 id，如 group:1234567890 / wechat:group:888888888。" },
          q: { type: "string", description: "可选：关键词过滤。" },
          limit: { type: "number", description: "最多几条，1–60，默认 15。" },
        },
      },
      output: textOutput,
      async execute(args) {
        const list = queryEvents({ chan: args.channel || "", convF: args.conv || "", q: args.q || "", limit: args.limit || 15, withOp: false });
        const text = list.length
          ? list.map(e => new Date(e.ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) +
            ` [${e.chan}${e.dir === "out" ? "·我" : ""}] ${e.convName || e.conv}${e.sender ? " " + e.sender : ""}：${e.text}`).join("\n")
          : "账本里没查到（可能还没同步到，或条件太窄）。";
        return { ok: true, text };
      },
    },
    {
      name: "fish_hub_state",
      description: "多端体检一张表：两边桥/D SH/微信 hook 的在离线、各会话潜水状态与两端工作模式、账本条数。要判断“哪条通道不对劲”先查这个。只读。",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      output: textOutput,
      async execute() {
        const m = await chanMap();
        return { ok: true, text: JSON.stringify({ health: m.health, qq: m.qq, wechat: m.wechat, ledgerEvents: events.length, chats: chats().slice(0, 8) }, null, 1) };
      },
    },
  ];
}

// ---------- 控制台页面（唯一一页：同屏 + 控制 + 插件 + 日志） ----------
const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>fish-hub · 小鱼总控台</title><style>
:root{--bg:#0b1220;--card:#111a2c;--card2:#0e1626;--tx:#dce7f5;--mut:#7d93ad;--blue:#4db2ff;--teal:#39d0c4;--warn:#ffb347;--qq:#57a9f7;--wx:#5ddc8f;--op:#b48cff;--line:#1d2b42}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.55 "Microsoft YaHei",system-ui}
header{display:flex;gap:12px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(11,18,32,.94);z-index:9;flex-wrap:wrap}
h1{font-size:16px;margin:0}#health{margin-left:auto;font-size:12px;color:var(--mut);display:flex;gap:12px;flex-wrap:wrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}.on{background:var(--wx)}.off{background:#ff6b6b}
nav{display:flex;gap:6px;padding:10px 18px 0;flex-wrap:wrap}
nav button{background:var(--card2);color:var(--mut);border:1px solid var(--line);border-bottom:none;border-radius:10px 10px 0 0;padding:7px 16px;cursor:pointer;font-size:14px}
nav button.act{color:var(--tx);background:var(--card);border-color:var(--blue)}
main{padding:14px 18px 90px;max-width:1150px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:13px}
.card h2{margin:0 0 6px;font-size:15px;color:var(--blue)}.card h3{margin:14px 0 6px;font-size:13px;color:var(--teal)}
.desc{color:var(--mut);font-size:12px;margin:0 0 10px}
.row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px dashed #16233a}.row:last-child{border-bottom:none}
.row label{flex:1;min-width:130px}.row .tip{color:var(--mut);font-size:11px;display:block}
input[type=number]{width:110px;background:var(--card2);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:5px 8px}
input[type=text],textarea,select{background:var(--card2);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:6px 8px;font:inherit}
textarea{width:100%;min-height:52px}
.sw{position:relative;width:38px;height:21px;flex:none}.sw input{opacity:0;width:0;height:0}
.sw span{position:absolute;inset:0;background:#243450;border-radius:22px;cursor:pointer;transition:.15s}
.sw span:before{content:"";position:absolute;width:15px;height:15px;border-radius:50%;background:#8fa8c4;top:3px;left:3px;transition:.15s}
.sw input:checked+span{background:var(--blue)}.sw input:checked+span:before{transform:translateX(17px);background:#fff}
.btn{background:var(--blue);border:none;color:#04121f;font-weight:700;border-radius:10px;padding:8px 18px;cursor:pointer;font-size:14px;margin-right:8px}
.btn.ghost{background:var(--card2);color:var(--tx);border:1px solid var(--line);font-weight:400}
.badge{font-size:11px;padding:2px 9px;border-radius:20px;background:#1b2a44;color:var(--mut)}.badge.pending{color:var(--warn);background:#3a2c14}
.badge.on{color:var(--wx);background:#14321f}.badge.off{color:#ff6b6b;background:#3a1a1a}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}
.pcard{background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:11px 13px}
.pcard .pn{font-weight:600;margin-bottom:2px}.pcard .pd{color:var(--mut);font-size:12px;min-height:20px}
#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#16283f;border:1px solid var(--blue);padding:10px 22px;border-radius:12px;opacity:0;transition:.25s;pointer-events:none;z-index:20;max-width:80vw}
#toast.show{opacity:1}
.tl{display:flex;flex-direction:column;gap:6px}
.ev{display:flex;gap:10px;padding:7px 10px;border-radius:10px;background:var(--card2);border:1px solid #152238}
.ev .tag{flex:none;font-size:11px;padding:2px 8px;border-radius:12px;height:fit-content;color:#04121f;font-weight:700}
.tag.qq{background:var(--qq)}.tag.wx{background:var(--wx)}.tag.op{background:var(--op)}
.ev .meta{color:var(--mut);font-size:11px}.ev .tx{word-break:break-all}
.cols{display:grid;grid-template-columns:270px 1fr;gap:13px}@media(max-width:840px){.cols{grid-template-columns:1fr}}
.chat{padding:7px 9px;border-radius:10px;cursor:pointer;margin-bottom:5px;border:1px solid transparent}
.chat:hover{background:#16233a}.chat.act{border-color:var(--blue);background:#152540}
.chat .cn{font-weight:600;font-size:13px}.chat .cl{color:var(--mut);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.filters button{background:#16233a;border:1px solid var(--line);color:var(--mut);border-radius:8px;padding:4px 12px;margin-right:6px;cursor:pointer}
.filters button.act{color:#04121f;background:var(--blue);border-color:var(--blue)}
.mono{font-family:Consolas,monospace}
</style></head><body>
<header><h1>🐟 fish-hub · 小鱼总控台</h1><span class="desc">唯一页：同屏账本 + 两边配置 + 插件装卸</span><div id="health">…</div></header>
<nav>
<button data-t="feed" class="act">🌐 多端同屏</button>
<button data-t="qq">🐧 QQ 仿真</button>
<button data-t="wx">💬 微信 Agent</button>
<button data-t="pl">🧩 插件</button>
<button data-t="log">📜 日志</button>
</nav>
<main>
<div id="t-feed"></div>
<div id="t-qq" hidden></div>
<div id="t-wx" hidden></div>
<div id="t-pl" hidden></div>
<div id="t-log" hidden></div>
</main>
<div id="toast"></div>
<script>
let ST=null,CST=null,filter="all",conv=null,q="",dirty={qq:false,wx:false};
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function toast(t){const el=$("#toast");el.textContent=t;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),3400)}
function fmt(ts){return new Date(ts).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"})}
async function j(u){return(await fetch(u)).json()}
async function post(url,body){const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})});const d=await r.json();if(!r.ok||d.error)throw new Error(d.error||r.status);return d}
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{document.querySelectorAll("nav button").forEach(x=>x.classList.remove("act"));b.classList.add("act");["feed","qq","wx","pl","log"].forEach(t=>$("#t-"+t).hidden=(t!==b.dataset.t))});
document.addEventListener("click",e=>{const b=e.target.closest?e.target.closest("[data-save],[data-rst]"):null;if(!b)return;if(b.dataset.save){b.dataset.save==="qq"?saveQQ():saveWX()}if(b.dataset.rst)rst(b.dataset.rst)});

// ---- 同屏 ----
async function renderFeed(){
  const el=$("#feed-list"); if(!el) return;
  const evs=await j("/api/events?channel="+encodeURIComponent(filter==="op"?"":filter)+"&conv="+encodeURIComponent(conv||"")+"&q="+encodeURIComponent(q)+"&limit=120");
  el.innerHTML=evs.events.map(e=>{
    const tag=e.dir==="op"?"op":(e.chan==="qq"?"qq":"wx");const lab=tag==="qq"?"QQ":tag==="wx"?"微信":"操作";
    return '<div class="ev"><span class="tag '+tag+'">'+lab+'</span><div><div class="meta">'+fmt(e.ts)+' · '+esc(e.convName||e.conv||"")+(e.sender?' · '+esc(e.sender):"")+'</div><div class="tx">'+esc(e.text)+"</div></div></div>";
  }).join("")||'<div class="desc">还没有事件——去任一通道说句话，几秒内这边就有</div>';
}
function feedShell(){
  const st=ST;
  $("#t-feed").innerHTML='<div class="cols"><div class="card"><h2>跨端会话目录</h2>'+
   st.chats.map(c=>'<div class="chat'+(conv===c.conv?" act":"")+'" data-conv="'+esc(c.conv)+'"><div class="cn">'+(c.chan==="qq"?"🐧":"💬")+' '+esc(c.convName||c.conv)+'</div><div class="cl">'+c.count+' 条 · '+esc(c.lastText||"")+'</div></div>').join("")+
   '</div><div class="card"><div class="filters" style="margin-bottom:8px"><button data-f="all" class="act">全部</button><button data-f="qq">🐧QQ</button><button data-f="wechat">💬微信</button><button data-f="op">⚙操作</button>'+
   '<input id="q" placeholder="搜索…" style="margin-left:8px;background:#0e1626;border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:4px 10px"></div><div id="feed-list" class="tl">…</div></div></div>';
  document.querySelectorAll("[data-conv]").forEach(el=>el.onclick=()=>{conv=(conv===el.dataset.conv?null:el.dataset.conv);renderFeed()});
  $("#t-feed").querySelectorAll(".filters button").forEach(b=>b.onclick=()=>{$("#t-feed").querySelectorAll(".filters button").forEach(x=>x.classList.remove("act"));b.classList.add("act");filter=b.dataset.f;renderFeed()});
  $("#q").addEventListener("input",e=>{q=e.target.value;renderFeed()});
  renderFeed();
}

// ---- 表单原语 ----
function sw(path,val,tip){return '<span class="row"><label>'+esc(tip[0])+'<span class="tip">'+esc(tip[1]||"")+'</span></label><span class="sw"><input type="checkbox" data-p="'+esc(path)+'" '+(val?"checked":"")+'><span></span></span></span>'}
function num(path,val,tip){return '<span class="row"><label>'+esc(tip[0])+'<span class="tip">'+esc(tip[1]||"")+'</span></label><input type="number" data-p="'+esc(path)+'" value="'+esc(val)+'"></span>'}
function sel(path,val,opts,tip){return '<span class="row"><label>'+esc(tip[0])+'<span class="tip">'+esc(tip[1]||"")+'</span></label><select data-p="'+esc(path)+'">'+opts.map(o=>'<option '+(o[0]===val?"selected":"")+' value="'+esc(o[0])+'">'+esc(o[1])+'</option>').join("")+'</select></span>'}
function collect(sec){const out={};document.querySelectorAll('#t-'+sec+' [data-p]').forEach(el=>{
  if(el.disabled)return;let v;
  if(el.dataset.arr)v=el.value.split("\\n").map(x=>x.trim()).filter(Boolean);
  else if(el.type==="checkbox")v=el.checked;
  else if(el.type==="number")v=el.value===""?undefined:Number(el.value);
  else v=el.value;
  if(v!==undefined)out[el.dataset.p]=v;});return out}
document.addEventListener("input",e=>{const p=e.target.dataset&&e.target.dataset.p;if(p)dirty[p.startsWith("socialV2")||p.startsWith("social")||p==="sendDelayMs"?"qq":"wx"]=true;});

function renderQQ(){
  const s=CST.qq.social||{},v2=CST.qq.socialV2||{};
  $("#t-qq").innerHTML='<div class="card"><h2>🌊 二代仿真</h2><p class="desc">现在跑着的这套：我自己按会话潜水/唤醒。工具开关关掉=我在 QQ 里变哑，建议保持开。</p>'+
  sw("socialV2.enabled",v2.enabled,["二代总开关","关掉退回一代"]) +
  sel("socialV2.agentPreset",v2.agentPreset,[["qq-chat-v2","qq-chat-v2（二代）"],["qq-chat","qq-chat（一代）"]],["行为配置档","换代=重启桥生效；最好让小鱼帮你改"])+
  sw("socialV2.provideRecommendations",v2.provideRecommendations,["给我推荐话术",""])+
  num("socialV2.autoReplyCheckMs",v2.autoReplyCheckMs,["自动查看间隔(ms)","多久醒来看一眼"])+
  '<h3>工具面开关</h3>'+Object.entries(v2.tools||{}).map(k=>sw("socialV2.tools."+k[0],k[1],[ "qq_"+k[0],""])).join("")+'</div>'+
  '<div class="card"><h2>✨ 一代行为参数（v2 仍在用的节奏）</h2>'+
  num("social.triggerProbability",s.triggerProbability,["被动唤醒概率 0~1",""])+
  num("social.proactiveProbability",s.proactiveProbability,["主动搭话概率",""])+
  num("social.proactiveIdleThresholdMs",s.proactiveIdleThresholdMs,["冷场判定(ms)","约"+Math.round((s.proactiveIdleThresholdMs||0)/60000)+"分钟"])+
  num("social.skipProbability",s.skipProbability,["跳话概率","故意不接更像真人"])+
  num("social.burstIntervalMinMs",s.burstIntervalMinMs,["连发最短间隔",""])+
  num("social.burstIntervalMaxMs",s.burstIntervalMaxMs,["连发最长间隔",""])+
  num("social.activeReplyDelayMinMs",s.activeReplyDelayMinMs,["回复延迟下限",""])+
  num("social.activeReplyDelayMaxMs",s.activeReplyDelayMaxMs,["回复延迟上限",""])+
  num("social.longGapProbability",s.longGapProbability,["偶尔长停顿概率",""])+
  num("social.maxReplyChars",s.maxReplyChars,["单条最大字数",""])+
  num("social.contextWindow",s.contextWindow,["上下文条数",""])+
  num("sendDelayMs",CST.qq.sendDelayMs,["底层发送节流(ms)",""])+
  '<h3>看到这些词必须回应</h3><textarea data-p="social.mustReplyKeywords" data-arr="1">'+esc((s.mustReplyKeywords||[]).join("\\n"))+'</textarea></div>'+
  '<div class="card"><h2>应用</h2><p class="desc">保存=只写 config.json（自动备份）。要生效点重启桥——只重启桥，不动 DSH/QQ 本体，断连十几秒。</p>'+
  '<button class="btn" data-save="qq">💾 保存</button><button class="btn ghost" data-rst="qq">🔄 重启 QQ 桥</button></div>';
}
function renderWX(){
  const w=CST.wx;const wms=w.wechat.workModes||{};const chatsK=Object.keys(w.wechat.chatModes||{});
  $("#t-wx").innerHTML='<div class="card"><h2>🎭 人格与唤醒</h2>'+
  sel("persona.default",w.persona.default||"",CST.roles.map(r=>[r,r]),["默认角色卡","WeChatAgent 自带 roles；注意：微信里的小鱼本体在 feiyu-memory，不吃这张表"])+
  sel("wechat.wake_mode",w.wechat.wake_mode,[["all","每条都醒"],["mention","只 @/名字"],["hybrid","混合"]],["唤醒方式",""])+
  sw("memberMemory.enabled",w.memberMemory.enabled,["群友记忆",""])+
  sw("history.enabled",w.history.enabled,["聊天历史摘要",""])+
  sw("search.enabled",w.search.enabled,["联网搜索","现在=关"])+
  sw("proactive.enabled",w.proactive.enabled,["微信主动发言","现在=关"])+'</div>'+
  '<div class="card"><h2>🖼 表情</h2>'+
  sw("stickers.enabled",w.stickers.enabled,["表情包总开关",""])+
  sw("stickers.collectEnabled",w.stickers.collectEnabled,["允许偷图收藏",""])+
  sw("stickers.shareEnabled",w.stickers.shareEnabled,["允许发收藏图",""])+'</div>'+
  '<div class="card"><h2>👥 各会话工作模式</h2>'+chatsK.map(c=>sel("workModes."+c,wms[c]||"assistant",[["assistant","助手"],["social","群友聊天"]],[c.replace("wechat:",""),""])).join("")+'</div>'+
  '<div class="card"><h2>应用</h2><button class="btn" data-save="wx">💾 保存</button><button class="btn ghost" data-rst="wx">🔄 重启 WeChatAgent</button><p class="desc">WeChatAgent 会被关掉再拉起（微信小号断一小会儿）；没弹回来就双击桌面图标。</p></div>';
}
function renderPL(){
  const known={ "fish-bridge":"旧微信直发（已并进 fish-hub，待换代后可停用）","feiyu-memory":"人格与跨会话记忆——关掉=失忆，🔒","preset-yu-wechat":"微信版小鱼 🔒","ui-skin-claude-style":"界面皮肤","web-ui-pet":"桌宠鲸鱼","dsh-whale-widget":"鲸鱼挂件","wallpaper-engine":"壁纸引擎","wallpaper-engine-about-notice":"壁纸·关于","wallpaper-engine-mascot-avatar":"壁纸·头像","wallpaper-engine-media-bridge":"壁纸·媒体桥","wallpaper-engine-pet-link":"壁纸·桌宠联动","wallpaper-engine-fx":"壁纸·特效","wallpaper-engine-parallax":"壁纸·视差","wallpaper-engine-fonts":"壁纸·字体","xmanrui-dsh-im":"旧微信IM（已被取代）","web-ui-remote-web-ui":"远程界面","web-ui-session-archive":"会话自动归档","dsh-fish-hub":"大插件本体：路由+直发+账本+这页控制台（🔒 别关，关了这页和我一半功能都没了）","fish-soul":"能力路由（将并入大插件）","fish-hub":"大插件本体（路由+直发+账本+控制台）","dsh-social-bridge-plugin":"微信社交桥 🔒","agent-preset-registry":"Preset 注册表 🔒","permission":"权限档位 🔒","feiyu-hub-note":""};
  $("#t-pl").innerHTML='<div class="card"><h2>🧩 插件装卸</h2><p class="desc">只有装饰/历史类能一键开关（写 cordis.patch.yml，<b>下次宿主换代生效</b>）。其余显示 🔒——那些动了会伤到通道或我自己。</p><div class="grid">'+
  CST.patchEntries.map(e=>{
    const canToggle=CST.toggleable.includes(e.id);
    const lab=known[e.id]||"";
    return '<div class="pcard"><div class="pn mono">'+esc(e.id)+' <span class="badge '+(e.disabled?"off":"on")+'">'+(e.disabled?"停用":"运行")+'</span></div><div class="pd">'+esc(lab)+'</div>'+
    (canToggle?'<span class="sw"><input type="checkbox" data-pl="'+esc(e.id)+'" '+(e.disabled?"":"checked")+'><span></span></span>':'<span class="badge">🔒 需换代</span>')+'</div>';
  }).join("")+'</div></div>';
  document.querySelectorAll("[data-pl]").forEach(el=>el.onchange=async()=>{try{await post("/api/plugins",{id:el.dataset.pl,disabled:!el.checked});toast((el.checked?"已启用 ":"已停用 ")+el.dataset.pl+" —— 下次换代生效");await loadCfg();renderPL();}catch(e){toast(e.message)}});
}
async function renderLog(){
  const d=await j("/api/audit");
  $("#t-log").innerHTML='<div class="card"><h2>📜 审计日志（最近 50 条）</h2><p class="desc mono">'+d.lines.map(esc).join("<br>")+'</p></div><div class="card"><h2>🗂 备份（近 20 份）</h2><p class="desc mono">'+d.files.slice(-20).map(esc).join("<br>")+'</p></div>';
}
async function saveQQ(){try{const r=await post("/api/qq-config",{patch:collect("qq")});toast(r.errors.length?"有键被拒: "+r.errors.join(";"):"已写入 config.json"+(r.applied.length?"（改动 "+r.applied.length+" 项，待重启桥）":"（无变化）"));dirty.qq=false;}catch(e){toast(e.message)}}
async function saveWX(){try{const r=await post("/api/wechat-config",{patch:collect("wx")});toast(r.errors.length?"有键被拒: "+r.errors.join(";"):"已写入 wechatagent.json"+(r.applied.length?"（改动 "+r.applied.length+" 项，待重启 WeChatAgent）":"（无变化）"));dirty.wx=false;}catch(e){toast(e.message)}}
async function rst(k){if(k==="wx"&&!confirm("重启 WeChatAgent（微信小号会断一小会儿）？"))return;try{toast((await post("/api/restart-"+k,{})).msg)}catch(e){toast(e.message)}}
async function loadCfg(){CST=await j("/api/config")}
async function load(){
  ST=await j("/api/state");
  const h=ST.health;
  $("#health").innerHTML=Object.entries({qqBridge:"QQ桥",dsh:"DSH宿主",wxOnebot:"微信OneBot",wxHook:"微信Hook",hub:"hub"}).map(([k,t])=>'<span><span class="dot '+(h[k]?"on":"off")+'"></span>'+t+'</span>').join("")+'<span>账本 '+ST.counts.events+' 条</span>';
  await loadCfg();
  if(!$("#t-feed").innerHTML)feedShell();
  if(!dirty.qq)renderQQ();if(!dirty.wx)renderWX();renderPL();
  if(!document.getElementById("t-log").hidden)renderLog();
}
load();setInterval(async()=>{try{await load()}catch{}},8000);
document.querySelector('[data-t=log]').addEventListener("click",()=>renderLog());
</script></body></html>`;

// ---------- 服务 ----------
export function startCore(config = {}) {
  const port = config.port || 3212;
  loadLedger();
  tick();
  const ticker = setInterval(tick, 4000);
  let chanCache = null;
  const mapTimer = setInterval(() => { chanMap().then(m => chanCache = m).catch(() => {}); }, 10000);
  chanMap().then(m => chanCache = m);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const send = (code, obj, type) => { res.statusCode = code; res.setHeader("Content-Type", type || "application/json; charset=utf-8"); res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
    if (req.method === "GET" && u.pathname === "/") return send(200, PAGE, "text/html; charset=utf-8");
    if (req.method === "GET" && u.pathname === "/api/events") {
      const list = queryEvents({ chan: u.searchParams.get("channel") || "", convF: u.searchParams.get("conv") || "", q: u.searchParams.get("q") || "", limit: +u.searchParams.get("limit") || 100, withOp: u.searchParams.get("channel") !== "no" });
      return send(200, { count: list.length, events: list });
    }
    if (req.method === "GET" && u.pathname === "/api/chats") return send(200, chats());
    if (req.method === "GET" && u.pathname === "/api/health") return send(200, { ok: true, events: events.length, ts: Date.now() });
    if (req.method === "GET" && u.pathname === "/api/map") return send(200, chanCache || {});
    if (req.method === "GET" && u.pathname === "/api/state") {
      return send(200, { health: chanCache ? chanCache.health : {}, map: chanCache, chats: chats().slice(0, 12), counts: { events: events.length } });
    }
    if (req.method === "GET" && u.pathname === "/api/config") {
      try {
        let wake = {}; try { wake = readJson(QQ_WAKE_STATE).conversations || {}; } catch {}
        const roles = fs.existsSync(WX_ROLES) ? fs.readdirSync(WX_ROLES).filter(f => f.endsWith(".md")).map(f => f.replace(/\.md$/, "")) : [];
        return send(200, {
          qq: readJson(QQ_CFG), wx: readJson(WX_CONFIG), roles,
          wake: Object.entries(wake).map(([k, v]) => ({ conv: k, mode: v.wakeConfig?.mode, prob: v.wakeConfig?.triggers?.probability, wakeCount: v.wakeConfig?.wakeCount })),
          patchEntries: parsePatch().map(e => ({ id: e.id, name: e.name, disabled: e.disabled })),
          toggleable: [...TOGGLEABLE],
        });
      } catch (e) { return send(500, { error: e.message }); }
    }
    if (req.method === "GET" && u.pathname === "/api/audit") {
      const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : [];
      const lines = fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, "utf8").trim().split(/\r?\n/).slice(-50) : [];
      return send(200, { files, lines });
    }
    if (req.method === "POST") {
      let body = ""; req.on("data", c => body += c); req.on("end", async () => {
        try {
          const j = JSON.parse(body || "{}");
          if (u.pathname === "/api/qq-config") return send(200, applyPatch("qq", j.patch));
          if (u.pathname === "/api/wechat-config") return send(200, applyPatch("wechat", j.patch));
          if (u.pathname === "/api/plugins") {
            try { return send(200, { ok: true, changed: togglePatchEntry(String(j.id), !!j.disabled) }); }
            catch (e) { return send(400, { error: e.message }); }
          }
          if (u.pathname === "/api/restart-qq") return send(200, { msg: await restartQQ() });
          if (u.pathname === "/api/restart-wx") return send(200, { msg: await restartWx() });
          if (u.pathname === "/api/ingest") { tick(); return send(200, { ok: true, events: events.length }); }
          return send(404, { error: "no route" });
        } catch (e) { return send(400, { error: e.message }); }
      });
      return;
    }
    send(404, { error: "no route" });
  });
  let retry = null;
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      audit("hub 端口 " + port + " 被占（可能独立进程还开着），10 秒后重试");
      retry = setInterval(() => {
        if (!server.listening) {
          try { server.listen(port, "127.0.0.1"); if (server.listening) { clearInterval(retry); audit("hub 端口接管成功"); } } catch { }
        } else clearInterval(retry);
      }, 10000);
    } else audit("hub server error: " + e.message);
  });
  server.listen(port, "127.0.0.1", () => audit("fish-hub core 上线 :" + port));
  return {
    stop() {
      clearInterval(ticker); clearInterval(mapTimer); if (retry) clearInterval(retry);
      saveCursors(); server.close();
      audit("fish-hub core 下线");
    },
    api: { queryEvents, chats, chanMap, applyPatch, startCore, tick },
  };
}
