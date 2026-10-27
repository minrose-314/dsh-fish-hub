## PR 自检（逐项打勾）

- [ ] `npm run check && npm run check:ui` 双绿（输出贴在本描述里）
- [ ] 动过 UI：curl 线上 `:3212` 抠 `<script>` 过 `node --check` 的实证（求值后形态，不是源码形态）
- [ ] 动过写路径：白名单键 / 改前备份 / 进审计，三件套齐全
- [ ] 没有新增硬编码端口或绝对用户路径（外部路径走 env 或配置）
- [ ] CHANGELOG.md 加了 Unreleased 条目
- [ ] 不含任何真实会话 id / token / 个人信息（`git grep` 自查）

## 变更说明

<!-- 为什么改 > 改了什么。关联 issue 用 Fixes #n -->
