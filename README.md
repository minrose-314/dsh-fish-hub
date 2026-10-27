# dsh-fish-hub

QQ / 微信**多端互通中枢**插件（DeepSeek Harness / Cordis bundle）。

把两条独立 IM 桥（QQ：SnowLuma OneBot 桥；微信：WeChatAgent hook）的消息历史合并进**同一个追加式事件账本（JSONL，人眼可审、grep 可查）**，让 Agent 在任意一端都能查另一端"刚才说了什么"；并提供一个五合一本地总控台（`:3212`）作为唯一管理入口。

> 定位说明：这是一个**个人自动化流水线的"家用电器"**——它不自带 IM 连接能力，消息收发仍由外部桥完成；本插件做的是**汇聚、观测、配置与闸门**。

**MIT · dsh ≥0.2.0-rc.2 · node ≥22 · Windows-first（ops 脚本为 PowerShell）· CI 全绿才见 main**

## 5 分钟上手

1. 前提：你已经有 QQ 桥（SnowLuma/OneBot，日志在 `~/qq-bridge/state/`）与微信 hook（WeChatAgent）。本插件**不自己连 IM**，只做汇聚、观测与闸门
2. `dsh plugin --profile <profile> add github:<owner>/dsh-fish-hub`（本地开发用 `file:` 路径），重启宿主
3. `cp targets.example.json data/targets.json` 填你自己的会话 id（详见「本地化配置」）
4. 开 http://127.0.0.1:3212 ——账本开屏即录，四个健康灯即点即亮

> 📸 截图区（发版前补三张）：账本同屏 / 通道配置页 / 插件装卸闸门

## 它解决什么问题

- QQ 和微信各一套日志、各一个控制台、各一份会话状态，跨端问答靠人肉翻
- 宿主/网关端口会漂（重启换端口、端口占用自增），硬编码探活全是假警报
- 想临时装卸某个能力（表情、壁纸、面板）不敢动 profile，怕要重启全家

## 功能清单

### 1. 统一事件账本
- 增量解析 `qq-bridge/state/bridge.log` 与 `WeChatAgent .../hook.log` 进同一 `data/events.jsonl`（追加式，带游标断点续读）
- 字段：时间 / 通道(qq·wechat·op) / 方向(in·out) / 会话 / 发送者 / 正文 / 消息 ID
- 操作记录（op）单独成流：谁在什么时候改了哪个配置、重启了哪座桥，都进账本可回放

### 2. Agent 查询工具
| 工具 | 用途 | 风险 |
|---|---|---|
| `fish_hub_state` | 多端体检一张表：两桥/宿主/微信网关在离线、各会话潜水状态与两端工作模式、账本条数 | 只读 |
| `fish_hub_events` | 跨端消息回读：按通道/会话/关键词过滤，时间序返回（含你自己发出去的） | 只读 |

### 3. 总控台（http://127.0.0.1:3212）
五个页签同屏：**账本**（通道/会话/关键词过滤的瀑布流）· **QQ 仿真**（唤醒参数、必回复词，保存=写桥 config 并备份，重启桥与宿主解耦）· **微信**（工作模式/回复门槛等）· **插件装卸**（TOGGLEABLE 白名单内的装饰类能力实时开合，其余 40+ 核心项上锁）· **审计**（决策日志）。端口无人监听时桌面启动脚本自动降级为独立救援实例。

### 4. 端口漂移自适应
- 宿主健康点跟随 `qq-bridge config → dsh.baseUrl` 实时读取，不猜端口
- 微信 OneBot 网关探活读 `ports.onebot` 基准值并向 +1/+2 邻带扫描（网关占用会自增）

### 5. ops 换代链（脱离进程树的重启编排）
- `restart-dsh.ps1`：120 秒缓冲（可 `state/cancel-restart` 取消）→ 杀宿主 → 等 GUI 回归 → 自动调桥 `/api/restart` 焕新票据 → 守护回写新端口。修好了"重启接口 415"与桥票据过期两个坑
- 桥重启**只动桥**，不惊扰 DSH/QQ 本体，断连约十几秒

## 架构

```
index.mjs          分层容错装配（任一层坏不拖垮其余）
├─ soul/           人格记忆层（persona-memory：跨会话共享档案）*个人件*
├─ bridge/         IM 工具层（微信直发/通道体检/近况回读）*白名单目标*
└─ hub/            账本 + 总控台 + 状态聚合（本 README 的主体功能）
    core.mjs
└─ ops/            换代/重启编排脚本
```

## 外部依赖（不随插件安装）

| 组件 | 插件怎么用 |
|---|---|
| SnowLuma QQ 桥 | 读 `bridge.log`；调本地 `:3100` console API（需 `x-console-token`）|
| WeChatAgent | 读 `hook.log` / `social-messages.json`；读写其 config |
| DSH host ≥0.2.0-rc.2 | 插件宿主 |

## 安装

本地目录形态（当前开发方式）：

```bash
# 放入 ~/.dsh/local-plugins/ 后在 profile 挂载（package.json bundles 加 "file:..."）
# Windows MSYS2 注意：node_modules 联接要用 Junction（New-Item -ItemType Junction），ln -s 会退化成拷贝
```

装完重启 DSH 生效；总控台随宿主起（`:3212`）。

## 安全与隐私（发布前必读）

- 服务只绑 `127.0.0.1`，不外放；对外仅访问本机回环的桥 API
- **账本 `data/` 里是真实聊天明文，`audit.log` 是操作史，`backups/` 是带 token 的旧 config** —— 已在 `.gitignore` 排除，发布前请再核对一遍
- `soul/`、`bridge/` 两层硬编码了个人档案与微信/QQ 白名单目标，二次分发者应替换为自己的或做配置化

## 已知问题

1. `soul`/`bridge` 层的工具面偏个人向，未提供配置向导（微信目标已改 `data/targets.json` 配置化）
2. 账本对 QQ **出站消息只记到"成功 N/M 条"**，正文未入库（桥日志形态所限）

## 本地化配置（二次分发三步走）

1. `cp targets.example.json data/targets.json` 并填自己的 onebot 会话 id（`data/` 不进包）
2. 微信数据根目录：环境变量 `FISH_HUB_WX_ROOT`（账本侧）/ `FISH_BRIDGE_WX_ROOT`（发送侧），默认 `D:/WeChatAgent/data/workspace`
3. QQ 桥固定在 `~/qq-bridge/`；不同路径可用 `FISH_WX_TARGETS_FILE` 指定 targets 文件位置

## 发布清洗记录（2026-10-27 已完成）

- [x] 真实微信/QQ 会话 id 移出源码（`wechat-channel.mjs` 改读 `data/targets.json`；工具描述示例换假 id）
- [x] WeChatAgent 绝对路径参数化（`FISH_HUB_WX_ROOT`）
- [x] token/密钥零硬编码（扫描确认；运行时读取）
- [x] `data/`、`backups/`、`audit.log` 由 `.gitignore` 与 `files[]` 双重排除
- [x] 控制台保存/重启按钮改 `data-save`/`data-rst` 事件委托（引号吞转义问题根除）
- [ ] README/package.json 的 `<owner>` 占位换真实仓库地址（建库时填）

## 社区

| 文件 | 内容 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | Keep a Changelog 格式的版本史 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发回路 + 本项目用两次线上僵死换来的验收纪律 |
| [SECURITY.md](SECURITY.md) | 运行边界与设计权衡 |
| `.github/` | Issue/PR 模板 与 CI（纯静态闸门：`npm run check && npm run check:ui`，不依赖外部桥，任何 runner 都能跑绿） |

## License

MIT
