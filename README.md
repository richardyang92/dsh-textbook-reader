# dsh-textbook-reader

DeepSeek Harness（DSH）插件：**教材伴读**。

MVP 目标是把一本 PDF 教材变成可检索、可引用、可跟踪进度的学习工作台：

- 从 MinerU 解析结果自动生成 **书 → 章 → 节** 三级章节树，允许手动改名、合并、纠正错层；
- 每本书记录**当前页、已读章节、每章掌握度自评、疑问清单**，重启/跨会话不丢；
- 聊天回答带 `[p.N]` 页码引用，点击后跳到对应页并高亮原文块；
- 独立 pdf.js 阅读器，通过官方侧栏入口 + 主面板 iframe 承载，默认不修改官方界面。

> 当前状态：**M0 骨架**。宿主半可加载；路由、解析、阅读器与工具在后续里程碑实现。技术方案见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

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

后续里程碑会把浏览器半构建到 `lib/client.js`，把阅读器构建到 `reader/app.js`，并把 pdf.js 放到 `reader/vendor/`。

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

## 验收计划

1. ≥400 页教材生成三级章节树，可手工修正；
2. 提问回答带页码，点击跳回并高亮；
3. 重启后书籍/章节/进度不丢；
4. 无 token 或网络失败时明确报错并降级；
5. 未开启图注时零额外外发请求。

当前没有 MinerU token，真实解析链路会在 M2 用合成数据/固定 fixture 先实现，待 token 配置后补做一次真实 API 校准与 400 页样书验收。

## 许可

MIT。阅读器将包含 Apache-2.0 许可的 pdf.js，随附其许可证与 NOTICE。
