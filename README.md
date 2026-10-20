# dsh-textbook-reader

DeepSeek Harness（DSH）插件：**教材伴读**。

MVP 目标是把一本 PDF 教材变成可检索、可引用、可跟踪进度的学习工作台。当前能力：

- 从 MinerU 解析结果自动生成 **书 → 章 → 节** 三级章节树，允许手动改名、合并、纠正错层；
- 每本书记录**当前页、已读章节、每章掌握度自评、疑问清单**，重启/跨会话不丢；
- 聊天回答带 `[p.N]` 页码引用，点击后跳到对应页并高亮原文块；
- 独立 pdf.js 阅读器，通过官方侧栏入口 + 主面板 iframe 承载，默认不修改官方界面。

> 当前状态：**M5 完成（MVP 代码）**。420 页三级树、真实 DSH 端到端 `[p.N]` 点击高亮、重启持久化、无 token/网络失败降级、图注关闭零额外外发均已验证。真实 MinerU token 与桌面端安装待用户环境补齐，见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

## 范围

做：PDF、三级章节树、页码锚定问答、学习进度、失败降级。

不做：EPUB、多书对照、习题自动判分、整本翻译、本地 MinerU、本地模型。

图注 VLM 描述默认关闭，MVP 不实现任何图注外发；见 [docs/VLM-CAPTIONS.md](docs/VLM-CAPTIONS.md)。

## 环境

- Node.js ≥ 22
- pnpm 11
- DSH 0.2.x（桌面端或 `dsh web`）

## 开发

```bash
pnpm install
pnpm build       # 宿主半 -> dist/
pnpm test        # 构建后跑 node:test
pnpm typecheck
```

### 不装插件先看 UI（fixture 服务器）

```bash
pnpm build
node scripts/seed-m2-demo.mjs --data test/.tmp/demo --fresh
node scripts/dev-server.mjs --data test/.tmp/demo --port 52000
# 打开 http://127.0.0.1:52000/textbook-reader/
```

seeder 使用假 MinerU 客户端和内存 fixture，不发网络请求；用于验证书架、解析结果、章节树、书名/掌握度/疑问与页码高亮。

### 真实 MinerU 校准

拿到 token 后（设置页保存到 `~/.dsh/textbook-reader/mineru-token`）：

```bash
pnpm probe:mineru --pdf /path/to/one-page.pdf
```

脚本只打印脱敏结构（状态、zip 条目名、JSON 顶层字段、bbox 样例），不打印 token、Authorization 或签名 URL。会消耗少量 MinerU 页额度。

当前无 token，真实云 API 的响应/zip 结构尚未实测；适配层按文档与自适应发现实现，实测后用 probe 输出固化 fixture。

## 使用

侧栏点「教材伴读」→ 上传 PDF → 在阅读器设置里配 MinerU token → 开始解析 → 在对话里提问，回答里的 `[p.N]` 可点击跳回并高亮。

## 安装

### 桌面端（正式交付路径）

CLI 无法管理 desktop profile，桌面端归 Electron 应用所有：

1. 确保已执行 `pnpm install && pnpm build`；
2. 桌面端 → **插件 → 添加插件** → 填本目录绝对路径
   `/absolute/path/to/dsh-textbook-reader`；
3. 安装后打开插件详情并**启用**，重启桌面端。

### 开发期 web profile

```bash
dsh plugin --profile web add file:/absolute/path/to/dsh-textbook-reader
```

使用 `file:` 而不是 `link:`：`link:` 不安装插件依赖，宿主启动时可能找不到运行时依赖。

## 数据与安全

- 数据根：`~/.dsh/textbook-reader/`；可执行环境变量 `TEXTBOOK_READER_DATA_DIR` 覆盖（测试/便携场景）。
- MinerU token：写入 `~/.dsh/textbook-reader/mineru-token`，文件权限 `0600`，目录 `0700`。
- 界面与 API 只返回掩码（如末 4 位），**永远不回传明文**；token 不写日志、不进仓库、不进错误信息。
- 只向 MinerU 官方接口与其签名 CDN 发起解析请求；图注 VLM 关闭时没有任何额外图片外发。
- 不提交 token、模型缓存、真实解析产物。

## 目录

```
src/            宿主半（Cordis 插件）
src/client/     浏览器半（后续里程碑）
src/reader/     独立 pdf.js 阅读器（后续里程碑）
reader/         静态阅读器页面/vendor
presets/        预留
scripts/        构建与校准脚本
test/           node:test
docs/           架构与决策
```

## 当前限制

- 未配置 MinerU token 时，解析会明确返回 `token_missing`，不会静默失败；
- 单个 MinerU 任务 ≤600 页；>600 页已实现 pdf-lib 本地分段（每段 ≤600 页）并合并页号；
- 图注 VLM 关闭时没有任何图片/VLM 外发（MinerU 解析本身除外）；
- 阅读器已使用本地 vendored pdf.js（不依赖 CDN/本地模型）。

## 验收计划

1. ≥400 页教材生成三级章节树，可手工修正；
2. 提问回答带页码，点击跳回并高亮；
3. 重启后书籍/章节/进度不丢；
4. 无 token 或网络失败时明确报错并降级；
5. 未开启图注时零额外外发请求。

开发环境暂无 MinerU token：已用合成 420 页数据验证三级树与 bbox 归一化；真实 API 校准与 400 页样书验收待 token 配置后补做，见 [docs/VERIFY-M2.md](docs/VERIFY-M2.md) 与 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

## 许可

MIT。阅读器将包含 Apache-2.0 许可的 pdf.js，随附其许可证与 NOTICE。
