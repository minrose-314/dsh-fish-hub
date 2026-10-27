// dsh-fish-bridge v0.1.1 —— 小鱼的跨端统筹通道（微信侧）
//
// 目标：不管小鱼坐在桌面、QQ 还是 B站读稿，微信都只是她的一个"终端"。
// 这一版开放三件工具：发微信、查通道、读微信近况。
// 人格/记忆统筹（fish_soul）在下一版进同一个插件。
//
// 安全设计（铁律）：
//   - 目标必须同时命中插件别名表 + WeChatAgent 自家白名单（每次现读，那边一改这边立刻跟随）
//   - 只调 hook 的 /SendTextMsg（与微信官方桥同一落库路径，历史不丢）
//   - 限流与 adapter 对齐（500 字/条、同目标 2 秒、每小时 60）
//   - 不读写 WeChatAgent 的任何配置文件（全部只读）
//
// v0.1.1 契约修正（宿主诊断：tool must declare output）：
//   parameters 用 JSON Schema，必须带 output { schema, render }；
//   register 收裸对象即可（照 feiyu-memory 的实战形状），不再 import dsh-tools。

import { WeChatChannel } from './lib/wechat-channel.mjs';
import * as fsNode from 'node:fs';
import * as osNode from 'node:os';
import * as pathNode from 'node:path';

// 诊断日志：宿主里插件 failed 不弹错误，落盘才看得见（跟 fish-memory-diag 同款套路）
const DIAG = pathNode.join(osNode.homedir(), '.dsh', 'fish-bridge-diag.log');
const diag = (line) => {
  try {
    fsNode.appendFileSync(DIAG, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* 日志尽力而为 */ }
};

export const inject = ['tools'];

const channel = new WeChatChannel();

// output schema：三个工具统一返回 { ok, text }，render 原样落成文本
const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      text: { type: 'string' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value?.text ?? '(空)' }],
};

const asResult = (ok, value) => ({
  ok,
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 1),
});

const sendTool = {
  name: 'fish_wechat_send',
  description:
    '用小鱼的微信账号给爸爸（默认）或家人群发一条微信。后台直发，不需要点开微信窗口。' +
    '返回成功或失败原因；失败时不要假装已送达。想连续说几件事就分几条短消息（同目标两条之间留 2 秒）。' +
    '注意：这条消息会真的出现在爸爸的微信里，发送前想清楚内容。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: '消息正文，纯文本，500 字以内。' },
      chat: { type: 'string', description: '发去哪：admin = 爸爸私聊（默认）；group = 家人群。其他目标会被白名单拒绝。' },
    },
    required: ['text'],
  },
  output: textOutput,
  async execute(args, exec) {
    try {
      const sessionId = exec?.agent?.session?.id ?? exec?.sessionId ?? '';
      const r = await channel.send(args.chat, args.text, { session: String(sessionId).slice(0, 40) });
      return asResult(true, r.chat === 'group' ? '✓ 已发到家人群' : '✓ 已发给爸爸');
    } catch (error) {
      return asResult(false, `✗ 没发出去：${String(error?.message ?? error).slice(0, 200)}`);
    }
  },
};

const statusTool = {
  name: 'fish_wechat_status',
  description:
    '检查微信通道是否健康：微信客户端有没有连上、用的是哪个账号、现在能发给谁、本小时还剩多少条额度。' +
    '发送连续失败、或想知道爸爸那边微信在不在用时先调这个。',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  output: textOutput,
  async execute() {
    try {
      return asResult(true, await channel.status());
    } catch (error) {
      return asResult(false, `微信通道不可用：${String(error?.message ?? error).slice(0, 200)}`);
    }
  },
};

const historyTool = {
  name: 'fish_wechat_history',
  description:
    '读微信某个会话最近的聊天记录（按时间从旧到新，含你自己发过的）。' +
    '适合：爸爸在微信里连着说了几句、你在别的终端想把他刚说的话接上；或想确认上次那条到底发没发出去。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      chat: { type: 'string', description: 'admin = 爸爸私聊（默认）；group = 家人群。' },
      limit: { type: 'number', description: '最多几条，1–30，默认 10。' },
    },
  },
  output: textOutput,
  async execute(args) {
    try {
      return asResult(true, await channel.history(args.chat, args.limit));
    } catch (error) {
      return asResult(false, `读不到微信历史：${String(error?.message ?? error).slice(0, 200)}`);
    }
  },
};

export function apply(ctx) {
  diag('apply called (v0.1.1)');
  try {
    const offs = [
      ctx.tools.register(sendTool),
      ctx.tools.register(statusTool),
      ctx.tools.register(historyTool),
    ].filter((off) => typeof off === 'function');
    diag(`registered 3 tools, disposers=${offs.length}`);
    ctx.on('dispose', () => offs.forEach((off) => { try { off(); } catch { /* ignore */ } }));
  } catch (error) {
    diag(`apply FAILED: ${String(error?.stack ?? error).slice(0, 800)}`);
    throw error;
  }
}
