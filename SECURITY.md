# 安全政策 / Security Policy

## 运行边界（设计上就是这样的，不是承诺）

- 总控台只绑 `127.0.0.1`，不对外监听；对外 HTTP 仅访问本机回环上的桥 API
- 账本 `data/`、`backups/`、`audit.log` 含真实消息与旧配置，均被 `.gitignore` 与 `files[]` 双重排除——**不要把这三样发到任何公共仓库**
- 写操作三道闸：配置只碰白名单键 / 改前自动备份 / 动作全进审计
- 微信发送目标必须同时在 `data/targets.json` 与 WeChatAgent 白名单里（双闸，任何一边撤回即发不出）；读不到 targets 时**拒发而不是默认发送**

## 已知的安全权衡

- 桥 console token 等凭据由运行时从本地配置读取；插件源码零硬编码（CI 前的 `scripts/check.mjs` 不查密钥，PR 审查请人工盯一眼新增字面量）
- QQ 桥/WeChatAgent 自身的安全性不在本插件范围

## 报告漏洞

暂不开公共 issue 报安全问题（避免公开细节）。请走 GitHub 私有 advisory：仓库页 Security → Report a vulnerability，或Maintainer 邮箱（见仓库 About）。我们会 72 小时内响应；确认后会连同修复版本一起披露。
