# 技术方案

> 状态：方案 v1 已确认（主面板落位、无专用 agent preset、图注 VLM 默认关闭）。M0 骨架已提交。

## 1. 交付形态

单包 `dsh-textbook-reader`：

- **宿主半**：Cordis 插件，`dist/index.js`。注册 `textbook_*` agent 工具和 `/textbook-reader` 路由，负责 MinerU 调用、数据持久化、引用基址。
- **浏览器半**：`dsh.client` 声明的 React 插件，构建到 `lib/client.js`。在 `sidebar.panellist` 添加「教材伴读」入口，注册 `main` 面板，用 iframe 承载独立阅读器；拦截聊天里的引用链接。
- **阅读器页**：独立静态页面（pdf.js + 章节树 + 进度/疑问 + 设置），由宿主路由提供。默认不改官方界面。

## 2. 数据模型

数据根：`~/.dsh/textbook-reader/`，目录 0700；`mineru-token` 0600。

```ts
type ParseStatus =
  | 'none' | 'preparing' | 'uploading' | 'polling' | 'downloading'
  | 'normalizing' | 'done' | 'failed' | 'interrupted'

interface Book {
  id: string
  title: string
  pdf: string                 // 书目录内相对路径
  pages: number
  bytes: number
  sha256: string
  createdAt: string
  updatedAt: string
  parse: {
    status: ParseStatus
    progress?: number         // 0..100
    batchId?: string
    segments?: SegmentState[] // >600 页分段
    warnings: string[]
    error?: { code: string; message: string; hint?: string }
  }
}

interface Block {
  id: string
  page: number                // 1-based
  seq: number
  type: 'title' | 'text' | 'table' | 'image' | 'equation' | 'list' | 'other'
  level?: number
  text: string
  image?: string
  bbox: [number, number, number, number] // 统一归一化 0..1000，左上原点
}

interface TreeNode {
  id: string
  title: string
  level: 1 | 2                // 1=章，2=节；书是隐式根
  pageStart: number
  pageEnd: number
  parentId?: string
  children: string[]
  source: 'auto' | 'manual'
  order: number
}

interface Progress {
  currentPage: number
  readChapters: string[]
  mastery: Record<string, { level: 0 | 1 | 2 | 3 | 4 | 5; updatedAt: string }>
  questions: {
    id: string
    text: string
    nodeId?: string
    page?: number
    status: 'open' | 'resolved'
    createdAt: string
  }[]
  updatedAt: string
}
```

磁盘布局：

```
~/.dsh/textbook-reader/
├── config.json                 # 非敏感配置（可选）
├── mineru-token                # 0600，明文 token，仅宿主读取
└── books/<bookId>/
    ├── book.json
    ├── source.pdf
    ├── tree.json               # 当前树
    ├── tree.ops.json           # 手动 rename/merge/relevel 操作
    ├── progress.json
    └── parse/
        ├── job.json            # 解析状态，可跨重启恢复
        ├── download.zip
        ├── raw/                # MinerU zip 解压产物
        └── normalized.json     # 统一后的 pages/blocks/headings
```

写入统一 tmp+rename；书级串行锁；重启时恢复 `uploading/polling` 任务或标记 `interrupted`。

## 3. 路由

前缀 `/textbook-reader`，所有 JSON 接口只返回结构化结果，失败返回 `{ ok:false, error:{ code, message, hint? } }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 阅读器 HTML；支持 `?book=&page=&block=` |
| GET | `/assets/*` | 阅读器 JS/CSS |
| GET | `/vendor/*` | pdf.js 与 worker（本地 vendored） |
| GET | `/api/config` | 配置 + token 掩码 |
| PUT | `/api/config` | 写 token（0600）与解析参数，回显仅掩码 |
| GET | `/api/books` | 书列表（含解析/进度摘要） |
| POST | `/api/books` | raw PDF 上传，或 JSON `{ path, title }` |
| GET/DELETE | `/api/books/:id` | 详情 / 删除（需确认） |
| GET | `/api/books/:id/pdf` | PDF 流，支持 Range |
| POST | `/api/books/:id/parse` | 启动/复用解析 job |
| GET | `/api/books/:id/parse` | 查询解析状态 |
| GET | `/api/books/:id/tree` | 章节树 |
| POST | `/api/books/:id/tree` | `{ op: 'rename'|'merge'|'relevel', ... }` |
| GET | `/api/books/:id/pages/:n` | 页块 + bbox |
| GET | `/api/books/:id/search?q=&node=&limit=` | 全文检索 |
| GET/PUT | `/api/books/:id/progress` | 学习进度 |
| GET/PUT | `/api/active` | 当前书 |
| GET | `/api/books/:id/asset/*` | 解析图片（路径穿越防护） |

鉴权：优先 `connection.requestRejection(req)`；缺失时回环/同源 fail-closed 校验。所有写接口额外拒绝跨站/非回环。

## 4. MinerU

唯一解析通道：`https://mineru.net/api/v4`，`Authorization: Bearer <token>`。

流程：

1. `POST /file-urls/batch`，`files:[{ name, data_id, is_ocr, page_ranges? }]`，`model_version:"vlm"`，`enable_table:true`；
2. `PUT` 签名 URL 上传原始字节，**不带 Content-Type**；
3. 轮询 `GET /extract-results/batch/{batch_id}`，直到 `done/failed`；
4. 下载 `full_zip_url`，解压；
5. **自适应发现** `*content_list.json`、`layout.json`、`full.md`、`images/`，不硬编码文件名；
6. 归一化：页号、块类型、文本、HTML、图片、bbox；
7. 自动生成章节树。

限制与分段：

- 单文件 ≤200 MB、≤600 页；超过 200 MB 明确拒绝；
- 超过 600 页用 `pdf-lib` 本地切段（每段 ≤600 页），分别提交，合并时页号加段偏移；
- 参数 `model_version="vlm"`、`is_ocr`、`enable_table`、`page_ranges`；
- 回调可选，MVP 使用轮询。

真实响应字段以一次实测为准。M2 会先跑 `scripts/mineru-probe.mjs`（输出脱敏结构 + zip 清单），把实测形状固化成测试 fixture；在拿到 token 前，用合成 420 页 PDF + mock zip 完成树/UI 验收。

失败降级：

- 无 token：解析接口返回 `token_missing`，阅读器提示去设置；
- token 失效：保留 MinerU 错误码/文案（脱敏）；
- 网络/5xx：幂等 GET 指数退避重试；任务失败不自动无限重试；
- zip 缺 content_list/layout：进入 degraded 模式，PDF 仍可读，但明确提示无章节树/检索/引用；
- 任何情况下都不静默成功。

## 5. 引用桥

工具结果提供 `readerUrl`：

```md
[\[p.12\]](http://127.0.0.1:50857/textbook-reader/?book=b-xxx&page=12&block=b45)
```

- 显示文本是 `[p.12]`（Markdown 转义方括号），是真正的链接；
- 浏览器半 capture 阶段拦截 `a[href*="/textbook-reader/"]`，解析 `book/page/block`；
- 需要时 `ctx.layout.selectPanel('textbook-reader')`，等 iframe `ready` 后 `postMessage`；
- 阅读器滚到页，按 bbox 绝对定位高亮块；
- 阅读器「返回对话」→ 父级 `selectPanel(null)`。

不使用 DOM 注入/文本节点改写，避免破坏 React 渲染。

## 6. 组件划分

```
src/index.ts                 宿主入口
src/config.ts                路径/常量
src/store/                   原子文件、book/tree/progress、锁
src/mineru/                  API client、分段、zip、normalize
src/tree/                    自动生成、手动 ops、校验
src/search.ts                全文检索
src/routes/                  路由分发、鉴权、Range、静态文件
src/tools/                   textbook_* 工具
src/prompt.ts                引用契约系统提示
src/client/index.tsx         浏览器半
src/reader/main.ts           阅读器
scripts/build.mjs            构建
scripts/mineru-probe.mjs     真实 API 校准
test/*.test.mjs
```

构建：

- host：`tsc` → `dist/`
- client：esbuild 包 `window.__ModuleLoader__.load` → `lib/client.js`
- reader：esbuild → `reader/app.js`；pdf.js 从 `pdfjs-dist` 复制到 `reader/vendor/`
- React 走 DSH 平台基线，不打包进 client

## 7. 里程碑

| 里程碑 | 内容 | 验证 |
|---|---|---|
| M0 | git init、骨架、构建/测试、patch、初始 commit | `pnpm install && pnpm build && pnpm test`；git log |
| M1 | 存储、token、上传/导入、PDF 流、阅读器壳 | 掩码、安全、重启持久、桌面入口 |
| M2 | MinerU、自适应 zip、归一化、自动树 | 真实 1 页校准；≥400 页树 |
| M3 | 树编辑、进度/疑问、重启恢复 | 改名/合并/纠层；进度不丢 |
| M4 | 侧栏入口 + main iframe + 引用拦截 + 工具 | 提问带 `[p.N]`，点击跳页高亮 |
| M5 | >600 页分段、失败降级、安全/无外发、文档 | 验收 4/5 |
| M6 | 全量验收、截图、交付说明 | 逐条证据 |

## 8. 验收映射

1. ≥400 页三级树 + 手工修正：M2/M3
2. 回答带页码、点击跳回高亮：M4
3. 重启书籍/章节/进度不丢：M1/M3
4. 无 token/网络失败明确报错降级：M5
5. 图注关闭零额外外发：M5（外发 allowlist + 计数测试）
