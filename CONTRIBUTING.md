# 参与贡献 / Contributing

先说结论：**改完不发检，等于没改**。这个项目被"源码看着没毛病、浏览器拿到是坏 JS"咬过两次，所以下面的验收纪律是项目本体的一部分，不是客套。

## 开发回路

```bash
npm run check       # 全部 .mjs/.js 过语法
npm run check:ui    # 总控台页面按"浏览器拿到的形态"过解析器 + 回归断言
```

本地联调（宿主加载形态）：

```bash
# 放入 ~/.dsh/local-plugins/，profile 的 package.json bundles 里加 file: 挂载，重启宿主
# Windows + MSYS2 注意：node_modules 联接用 Junction（New-Item -ItemType Junction），ln -s 会退化成拷贝
```

## 验收规矩（改 UI 必读）

1. **检查求值后的字节**：页面 JS 活在 `hub/core.mjs` 的模板字符串里，内联 HTML 属性中出现 `'` 需要 `\'`，模板求值后只剩 `'`。所以 `node --check` 源文件**通过≠页面通过**——永远跑 `npm run check:ui`（或直接 curl `:3212` 把 `<script>` 抠出来 `--check`）。
2. **不要在模板字符串里再塞 HTML 内联事件**：一律 `data-*` + 事件委托（见 check-ui 的回归断言，将来加页签请扩断言）。
3. **端口不许硬编码**：一切 tcp 探活走"读配置 + 邻带扫描"（宿主端口每次启动会变，网关端口占用会自增，这是本机生态的物理规律）。
4. **写配置只碰白名单键**，改前备份到 `backups/`，动作进 `audit.log`——新增写路径必须过这三件套。

## 提 PR 的最低门槛

- [ ] `npm run check && npm run check:ui` 本地双绿
- [ ] 动过 UI：附求值后脚本 `--check` 的输出或截图
- [ ] CHANGELOG 加条目（Unreleased 段）
- [ ] 不新增任何"读不到的文件就崩"的路径——所有外部读取保持容错降级

## 风格

代码密度偏高（单文件 hub、模板内联页面）是历史形态，接受改造提案但先开 issue 讨论；注释用中文，讲"为什么"不讲"是什么"。

## 借鉴声明

社区件格式借自：Keep a Changelog（CHANGELOG 结构）、语义化版本、GitHub Community Health 惯例（CONTRIBUTING/SECURITY/模板）、standard 项目的"用脚本固化踩过的坑"思路。
