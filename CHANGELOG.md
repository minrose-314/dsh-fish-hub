# 更新日志 / Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-27

### Added
- 统一事件账本：QQ 桥 `bridge.log` 与 WeChatAgent `hook.log` 增量解析进同一 `data/events.jsonl`，游标断点续读；操作记录（op）单独成流
- Agent 查询工具 `fish_hub_state`（多端体检一张表）与 `fish_hub_events`（跨端消息回读，支持通道/会话/关键词过滤）
- 总控台 `:3212` 五页签：账本同屏 / QQ 仿真配置 / 微信配置 / 插件装卸闸门（TOGGLEABLE 白名单）/ 决策审计
- 端口漂移自适应：宿主健康点跟 `dsh.baseUrl` 实读；微信网关探活读配置基准 +1/+2 邻带扫描
- ops 换代链：宿主重启编排（120s 缓冲可取消 → 带桥换票 → 守护回写端口）
- 发布级工程件：`scripts/check.mjs`（全量语法闸门）、`scripts/check-ui.mjs`（页面 JS 按求值后形态过解析器 + 回归断言）、CI 工作流、CONTRIBUTING / SECURITY / ISSUE 模板

### Changed
- 微信目标会话 id 从源码迁至 `data/targets.json`（不进包；缺失时宁可拒发不盲发），示例见 `targets.example.json`
- WeChatAgent 数据根目录参数化：`FISH_HUB_WX_ROOT`（账本侧）/ `FISH_BRIDGE_WX_ROOT`（发送侧）/ `FISH_WX_TARGETS_FILE`
- 分层容错装配：soul / bridge / hub / hub-tools 任一层失败不拖垮其余（诊断落 `~/.dsh/fish-hub-diag.log`）

### Fixed
- 控制台保存/重启按钮整页僵死：内联 `onclick` 的引号在模板字符串求值中被吞。改为 `data-save`/`data-rst` + 全局事件委托，并以 `check-ui.mjs` 把"检查求值后的字节"固化为发布前硬闸门
- `renderFeed` 多余括号导致的页面冻结
- 换代链 `POST /api/restart` 缺 `Content-Type` 被 415 拒绝
- 桥票据过期：换代链末尾自动带桥重启换票

[0.1.0]: https://github.com/minrose-314/dsh-fish-hub/releases/tag/v0.1.0
