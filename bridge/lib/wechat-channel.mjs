// wechat-channel.mjs —— 小鱼统筹插件的微信通道
//
// 只做三件事：体检（reader+hook）、把 onebot 目标 id 解析成 wxid、调 hook /SendTextMsg 发文字。
// 安全边界与 WeChatAgent 自家桥完全对齐：
//   - 发送目标必须在 wechatagent.json 的 wechat.whitelist 里（每次现读，不缓存）
//   - 不能发给自己（ownWxid）
//   - 单条 ≤500 字、同一目标最短间隔 2 秒、每小时 ≤60 条
// 发送走 hook 本体接口，消息正常落进微信消息库（delivery_status 由 hook 落账），
// 所以微信侧小鱼的会话历史看得见这些消息，不会出现「发过却失忆」。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

// 与 adapter 同一套推导（改这里必须同步核对 scripts/hook-onebot.mjs）
export const onebotId = (value) =>
  Number(crypto.createHash('sha256').update(String(value)).digest().readBigUInt64BE(0) % 2147483647n + 1n);

export const conversationId = (wxid, name, mappedId) => {
  if (mappedId !== undefined) {
    if (!/^[1-9]\d*$/.test(String(mappedId)) || !Number.isSafeInteger(Number(mappedId))) {
      throw new Error('INVALID_CONVERSATION_ID');
    }
    return Number(mappedId);
  }
  return onebotId(wxid.includes('@chatroom') ? (name || wxid).replace(/\s*\(\d+\)\s*$/, '').trim() : wxid);
};

const CHATS = { admin: 'private', group: 'group' };
// kind → onebot 目标 id。从插件 data/targets.json 读取（个人配置，不随包发布；
// 参考 targets.example.json）。没配置时 ALIAS 为空——发送会被白名单闸门拒绝，
// 宁可拒发也不盲发。也可用环境变量 FISH_WX_TARGETS_FILE 指定别处的配置。
const ALIAS = (() => {
  try {
    const here = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/(\w:)/, '$1'));
    const file = process.env.FISH_WX_TARGETS_FILE || path.join(here, '..', '..', 'data', 'targets.json');
    const t = read(file);
    return { private: String(t.private || ''), group: String(t.group || '') };
  } catch { return { private: '', group: '' }; }
})();

async function jfetch(base, route, opts = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + route, { ...opts, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP_${res.status} ${route}: ${text.slice(0, 160)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export class WeChatChannel {
  constructor(root = process.env.FISH_BRIDGE_WX_ROOT || 'D:/WeChatAgent/data/workspace') {
    this.root = root;
    this.lastSend = new Map();
    this.hourWindow = { hour: '', count: 0 };
    this.auditFile = path.join(process.env.DSH_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh'), 'fish-bridge-audit.jsonl');
  }

  files() {
    return {
      cfg: path.join(this.root, 'config/wechatagent.json'),
      io: path.join(this.root, 'state/wechat-io-config.json'),
      token: path.join(this.root, 'state/hook/native-token.txt'),
    };
  }

  // 每次现读，WeChatAgent 改了配置立刻跟随（文件很小，成本可忽略）
  load() {
    const cfg = read(this.files().cfg);
    const io = read(this.files().io);
    const nativeToken = fs.readFileSync(this.files().token, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(nativeToken)) throw new Error('HOOK_TOKEN_MISSING');
    return { cfg, io, nativeToken };
  }

  async identity() {
    const { io } = this.load();
    const st = await jfetch(io.reader_base_url, '/api/v1/reader/status', { headers: { Authorization: 'Bearer ' + io.reader_token } });
    if (!st || st.backend !== 'weflow-cli-nt' || !st.ownWxid) throw new Error('READER_NOT_READY');
    return { ...st, account: String(st.accountDirectory || '').toLowerCase() };
  }

  async status() {
    const { cfg, io, nativeToken } = this.load();
    const id = await this.identity();
    const health = await jfetch(cfg.hook.baseUrl, '/WeChatAgent/health', { headers: { Authorization: 'Bearer ' + nativeToken, ...(id.account ? { 'X-WeChatAgent-Account': id.account } : {}) } });
    const wl = cfg.wechat.whitelist;
    return {
      wechat_connected: true,
      client_version: health.version ?? '',
      native_sticker_send: health.nativeStickerSend === true,
      account: id.account,
      targets: {
        admin: (wl.private || []).map(String).includes(ALIAS.private) ? '爸（私聊）' : null,
        group: (wl.groups || []).map(String).includes(ALIAS.group) ? '家人群' : null,
      },
      sent_this_hour: this.hourWindow.count,
    };
  }

  resolveKind(chat) {
    const kind = CHATS[String(chat || 'admin').toLowerCase()];
    if (!kind) throw new Error('UNKNOWN_CHAT（只能是 admin 或 group）');
    return kind;
  }

  async resolveTarget(kind, target) {
    const { io } = this.load();
    const data = await jfetch(io.reader_base_url, '/api/v1/sessions?limit=500', { headers: { Authorization: 'Bearer ' + io.reader_token } });
    const matches = (data.sessions ?? []).filter((s) => s.username &&
      (s.username.includes('@chatroom') ? 'group' : 'private') === kind &&
      String(conversationId(s.username, s.displayName, s.conversationId)) === String(target));
    if (matches.length !== 1) throw new Error('TARGET_MAPPING_AMBIGUOUS_OR_MISSING');
    return matches[0].username;
  }

  audit(row) {
    try { fs.appendFileSync(this.auditFile, JSON.stringify(row) + '\n'); } catch { /* 审计失败不挡发送 */ }
  }

  async send(chat, text, meta = {}) {
    const kind = this.resolveKind(chat);
    const target = ALIAS[kind];
    const clean = String(text ?? '').trim();
    if (!clean) throw new Error('EMPTY_TEXT');
    if (clean.length > 500) throw new Error('TEXT_TOO_LONG（500 字以内，长了自己拆几条发）');

    // 白名单现读：与 WeChatAgent 的闸门保持一致，它撤回名单这里就发不出去
    const { cfg } = this.load();
    const wl = cfg.wechat?.whitelist?.[kind === 'group' ? 'groups' : 'private'] ?? [];
    if (!wl.map(String).includes(String(target))) throw new Error('CONVERSATION_NOT_ALLOWED（不在微信白名单）');

    // 简易限流：同目标 2 秒、每小时 60 条
    const key = `${kind}:${target}`;
    const now = Date.now();
    if (now - (this.lastSend.get(key) || 0) < 2000) throw new Error('SEND_TOO_FAST（同一目标两条之间至少隔 2 秒）');
    const hour = new Date().toISOString().slice(0, 13);
    if (this.hourWindow.hour !== hour) this.hourWindow = { hour, count: 0 };
    if (this.hourWindow.count >= 60) throw new Error('HOURLY_QUOTA（本小时额度用完）');

    const id = await this.identity();
    const wxid = await this.resolveTarget(kind, target);
    if (wxid === id.ownWxid) throw new Error('SELF_TARGET_FORBIDDEN');

    const { cfg: c2, io, nativeToken } = this.load();
    const res = await jfetch(c2.hook.baseUrl, '/SendTextMsg', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + nativeToken,
        'Content-Type': 'application/json',
        ...(id.account ? { 'X-WeChatAgent-Account': id.account } : {}),
      },
      body: JSON.stringify({ wxidorgid: wxid, msg: clean }),
    }, 8000);
    if (res?.ret !== 0) throw new Error(`NATIVE_SEND_REJECTED ret=${res?.ret}`);

    this.lastSend.set(key, now);
    this.hourWindow.count += 1;
    this.audit({ at: new Date().toISOString(), kind, target: wxid, chars: clean.length, via: 'fish-bridge', ...meta });
    return { ok: true, chat: kind === 'group' ? 'group' : 'admin', at: now };
  }

  async history(chat, limit = 10) {
    const kind = this.resolveKind(chat);
    const n = Math.max(1, Math.min(30, Number(limit) || 10));
    const id = await this.identity();
    const wxid = await this.resolveTarget(kind, ALIAS[kind]);
    const { io } = this.load();
    const res = await jfetch(io.reader_base_url, '/api/v1/messages?talker=' + encodeURIComponent(wxid) + '&limit=' + (n * 2), { headers: { Authorization: 'Bearer ' + io.reader_token } }, 8000);
    const out = [];
    for (const row of (res.messages ?? []).slice(-40)) {
      // reader 的行是平铺字段：fullText/content 直接用；localType 1 = 纯文字，其余（表情/转发/图片）跳过
      const text = String(row.fullText || row.content || row.parsedContent || '').trim();
      if (!text || row.localType !== 1) continue;
      const at = row.createTime ? new Date(Number(row.createTime) * 1000).toISOString() : '';
      out.push({ at, who: row.isSend ? '我' : (row.senderDisplay || '对方'), text: text.slice(0, 300) });
      if (out.length > n) out.shift();
    }
    return { chat: kind === 'group' ? 'group' : 'admin', account: id.ownWxid ? '已登录' : '未登录', messages: out };
  }
}
