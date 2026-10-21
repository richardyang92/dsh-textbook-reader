# MVP 验收矩阵

日期：2026-10-21 · 版本 0.6.0

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | ≥400 页教材生成三级章节树，可手工修正 | ⚠️ 部分 | 420 页 PDF + 合成 MinerU 产物：8 章 / 32 节，点树跳页；改名/合并/纠层 API + UI 实测。**真实 MinerU 云解析与真实教材待 token**。见 [VERIFY-M5](VERIFY-M5.md)、[VERIFY-M3](VERIFY-M3.md) |
| 2 | 提问回答带 `[p.N]`，点击跳回并高亮 | ✅ | 真实 DSH Web profile：agent 调用 `textbook_list`/`textbook_search`，输出 `[p.1]` 链接；点击切到阅读器、页码 1、`.pdf-highlight` 数 1。见 [VERIFY-M4](VERIFY-M4.md) 与截图 |
| 3 | 重启后书籍/章节/进度不丢 | ✅ | 关闭并重启 fixture 服务器后 currentPage=125、8 章 32 节仍在；浏览器刷新后 page/已读/掌握度/疑问保留；Store 跨实例测试。见 [VERIFY-M1](VERIFY-M1.md)、[VERIFY-M5](VERIFY-M5.md) |
| 4 | 无 token 或网络失败明确报错并降级 | ✅ | UI 提示 token_missing + 配置入口；网络/超时/MinerU 错误码/坏 zip 均映射为结构化错误；无静默成功。见 [VERIFY-M5](VERIFY-M5.md) |
| 5 | 未开启图注时零额外外发 | ✅ | 外发审计测试：仅 MinerU API/上传/结果 CDN；零 caption/embedding/image-generation 请求；图注开关默认关闭、无实现。见 [VERIFY-M5](VERIFY-M5.md) |

## 必须说明的限制

- **真实 MinerU API 未实测**：开发环境暂无 token。zip 结构与 `content_list` 字段按官方文档 + 自适应发现实现，已用合成形状覆盖；`pnpm probe:mineru` 可在拿到 token 后一次性校准。
- **桌面端安装**：CLI 不能管理 desktop profile。桌面端需在「插件 → 添加插件」填本目录绝对路径、启用并重启。真实 Web profile 已完成同一 host/client bundle 的端到端验证。
- **>200 页** 已实现本地分段（每段 ≤200 页）并通过 23 页/上限 10 页的等价测试；实测 MinerU 拒绝 600 页任务（"number of pages exceeds limit (200 pages)"），隐藏上限时会对该段自动二分重试。
- 图注 VLM 是预留开关（默认关闭），MVP 不实现图片外发。
- 章节树重解析会重建；手动编辑不迁移（MVP 明确限制）。
