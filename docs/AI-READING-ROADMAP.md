# AI 帮读开发路线图（v0.6 → v1.0）

> 日期：2026-10-20 · 基线：v0.5.0（M1–M5 完成）
> **2026-10-20 方向修正**：目标已明确为「类似 Kimi 侧栏的聊天式学习」。本文件的交互部分（R2/R3 的 AI 卡片与"就地单次生成"）已被 [CHAT-LEARNING-ROADMAP.md](CHAT-LEARNING-ROADMAP.md) 取代；R0/R1 的上下文、检索、工具，R4 的自测/复习，以及评测/风险部分仍然有效，作为聊天方案的地基。
> 结论：上下文、检索与产物三块地基仍是前提；交互形态在 v2 中改为"聊天优先"，见 [CHAT-LEARNING-ROADMAP.md](CHAT-LEARNING-ROADMAP.md)。

---

## 1. 现状：结构有了，学习闭环没有

### 1.1 已经成立的能力

| 能力 | 现状 |
|---|---|
| PDF 入库与 MinerU 解析 | ✅ 自适应 zip、归一化、>200 页分段 |
| 章节树 | ✅ 自动生成 + 手动改名/合并/纠层 |
| 页码锚定引用 | ✅ `[p.N]` 点击跳页并高亮 block |
| 聊天内检索问答 | ✅ `textbook_search` 返回 5 条片段，带 `citationUrl` |
| 学习进度 | ✅ 当前页、已读章节、自评掌握度、疑问清单 |
| 阅读器 | ✅ pdf.js、懒渲染、章节树、进度侧栏 |

### 1.2 用户视角的四个断点

1. **问"这章讲什么"答不好。** Agent 只有 `textbook_search`，单次最多 5 条、每条 ≤800 字；没有"读整节/读整章骨架"的工具。问宏观问题只能撞关键词。
2. **想问"这段话什么意思"，得先离开阅读器。** 阅读器只有 canvas + 高亮层，没有文本层、没有选区；用户要么复制文本到聊天，要么描述"第 87 页第 2 段"。
3. **AI 说完就没了。** 导读、解释、总结都只是聊天消息；不能存成笔记、不能挂到章节、复习时找不回来。
4. **学没学会没人知道。** 掌握度靠手点自评；疑问清单只是待办；没有自测、错题、复习队列。

### 1.3 三个根因

- **上下文不足**：没有 section/chapter 级上下文构建器，也没有 token 预算管理。
- **入口不对**：AI 只能发生在聊天窗口，不在"正在读的这一页"。
- **资产缺失**：没有 Artifact / Quiz / Review 持久层，AI 输出不是一等公民。

---

## 2. 目标形态：读完一本教材的闭环

把产品从"可检索的 PDF 阅读器"升级为"陪你把一本教材读完的学习工作台"：

```
预读 ──────────→ 精读 ──────────→ 复盘 ──────────→ 复习
章节导读          选区解释          节末小结          错题重练
前置知识          术语/图表         概念清单          间隔重复
阅读路线          随读问答          自测题            薄弱点报告
   │                 │                 │                 │
   └──────────── 所有产物都带页码引用，可保存、可编辑、可导出 ────────────┘
```

### 2.1 六个设计原则

1. **原文优先**：先给教材原文/页码，再给解释；没有依据就说"教材没讲"。
2. **就地触发**：导读、解释、出题都在阅读器里完成，不强制切窗口。
3. **产物一等公民**：每次生成都落成 Artifact，可保存、可编辑、可删除、可导出。
4. **手动触发 + 预算可见**：不自动后台烧 token；每次显示范围、模型、用量。
5. **降级明确**：没有可用模型、超额、断流都给出可操作错误，不静默。
6. **数据留在本机**：除显式发起的模型调用外，不新增外发；日志不记正文。

### 2.2 三个典型场景

**场景 A：工作日晚上读 30 分钟**
打开第 3 章 → 点「本章导读」（3 分钟看完地图）→ 读 3.1 → 卡在一段 → 选中 → 「解释」→ 顺手「存为笔记」→ 节末点「自测」做 5 题 → 错题自动进复习队列。

**场景 B：周末复习 15 分钟**
打开书 → 「复习」标签显示 12 张到期卡 → 逐张翻卡评分 → 错题回跳原页 → 周报显示"本周 4 节、正确率 72%、薄弱点：3.2 反向传播"。

**场景 C：考前突击**
按薄弱点排序 → 重读标记小节（导读/小结已在，不用重新生成）→ 只做错题和重点概念卡 → 导出 Markdown 笔记到本地。

### 2.3 成功标准（v1.0）

- 打开一本已解析教材 → 点一次"本章导读" → 2 次点击内拿到带页码的导读。
- 选中一段 → 一次点击拿到解释，引用全部可跳回原文。
- 学完一节 → 5 道自测题 + 错题自动进入复习队列。
- 引用合法率 100%（自动化校验）；不可回答问题拒答率 ≥90%。
- 单次 AI 任务有明确 token 上限；每日预算可见、可调。

---

## 3. 差距清单与优先级

| # | 差距 | 用户影响 | 优先级 | 里程碑 |
|---|---|---|---|---|
| 1 | 无整节/整章上下文构建 | 宏观问题答不好、断章取义 | P0 | R1 |
| 2 | 无 `textbook_read` / `textbook_context` 工具 | Agent 只能搜片段 | P0 | R1 |
| 3 | 检索只有字面匹配，无 BM25/分词 | 自然语言问题召回差 | P0 | R1 |
| 4 | 阅读器无文本层/选区 | 无法"就问这段" | P0 | R3 |
| 5 | 无就地 AI 入口与流式输出 | 每次都要切聊天 | P0 | R2 |
| 6 | 无 AI 产物持久层 | 问答结束即消失 | P0 | R0/R2 |
| 7 | 无导读/小结 | 不知道一章在讲什么 | P1 | R2 |
| 8 | 无自测/判分/错题 | 掌握度无证据 | P1 | R4 |
| 9 | 无复习队列（间隔重复） | 学完就忘 | P1 | R4 |
| 10 | 无阅读计划/周报/术语表 | 缺少长期陪伴 | P2 | R5 |
| 11 | 无成本/隐私/同意管理 | 不敢开 AI | P0 | R2 |
| 12 | 无 AI 质量评测集 | 改坏了不知道 | P0 | R1 |

---

## 4. 技术方案

### 4.1 总览

```
┌───────────────────────────── Reader（iframe）─────────────────────────────┐
│  PDF 视图 / 新增「文本视图」   AI 伴读右栏（导读·讲解·笔记·自测·复习）      │
│  选区工具条                    设置：AI 开关 / 预算 / 同意                  │
└───────────────┬───────────────────────────────────────────┬───────────────┘
                │ HTTP + SSE（同源、loopback guard）          │ 引用跳转
┌───────────────▼───────────────────────────────────────────▼───────────────┐
│                        Host plugin（Cordis）                              │
│  ContextBuilder      AiService            ArtifactStore / Quiz / Review    │
│  section/chapter     llm 服务 + 默认模型   原子写、缓存、证据、复习调度       │
│  token 预算          流式 / 取消 / 预算      Markdown 安全渲染数据            │
│                                                                           │
│  Agent 工具：textbook_read / context / artifact_save / quiz_* / review_*   │
│  系统提示：引用契约 + 阅读流程                                              │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ tools
┌───────────────▼───────────────────────────────────────────────────────────┐
│                      DSH Agent（对话）                                    │
│  深度问答 / 跨章讨论 / 制定计划 / 批改与讲解                                │
└───────────────────────────────────────────────────────────────────────────┘
```

### 4.2 两条生成通道（关键决策）

| | Agent 通道（对话） | 就地通道（阅读器） |
|---|---|---|
| 入口 | 聊天框 | 导读/小结/选区按钮 |
| 大脑 | 当前会话 Agent（有工具、多轮） | 宿主 `llm` 服务，单次调用（无工具） |
| 优点 | 可追问、跨章、可规划、过程可见 | 快、不切窗口、上下文自动带 |
| 限制 | 要切窗口、要描述位置 | 不进聊天历史、v1 不能调工具 |
| 适合 | 深聊、跨章、计划、批改 | 导读、小结、解释、翻译、出题 |

**推荐：双通道 + 共享产物层。** 就地结果卡提供「在对话里继续聊」；对话里生成的导读/笔记也写入同一 ArtifactStore，阅读器能看到。这样两个入口不是两套记忆。

**为什么不只用 Agent 通道**：用户正在读第 87 页，卡在一段话；让他切到聊天窗口、描述位置、等 Agent 调工具，再切回来——这不是"帮读"，是"查资料"。就地入口是产品差异点。

**为什么不让宿主自己存 API Key**：DSH 已提供 `llm` 服务与默认模型选择，插件直接复用当前账号与模型路由，不引入第二套密钥与计费；模型不可用时明确降级。

### 4.3 上下文层（AI 的"眼睛"）

新增 `src/context/`：

- `section.ts`：按章节树节点取块，按 page/seq 排序；保留 `blockId`、页码、标题层级；跳过图片/表格正文，但保留 `[图 p.12]` 占位。
- `chapter.ts`：章级不塞全文，构建「骨架」——所有小节标题 + 每节首段/末段 + 已有小节摘要 + 页码范围。用于导读，成本低且覆盖全章。
- `budget.ts`：按字符保守估算 token（中文≈1 字/token），默认 12k 字符；超限时保留头尾、中间标注省略，并返回 `truncated/omitted`。
- `neighbors.ts`：上一节末尾、下一节开头各一段，解决"这节开头承接上文"的问题。
- `blocks.ts`：统一 `{id,page,type,text}` 引用表，供模型输出引用、供校验器核对。

工具输出必须**有界**：默认 6k 字符，最大 20k；返回 `truncated` 与 `nextCursor`，让 Agent 自己决定是否继续读，而不是一次塞爆上下文。

### 4.4 检索升级（R1）

现状 `src/search.ts` 是子串 + 中文 bigram + 固定加权。升级为：

1. `Intl.Segmenter('zh', {granularity:'word'})` 分词，英文按词；保留 bigram 兜底。
2. 每本书惰性建倒排索引 + BM25（k1=1.2, b=0.75），标题/小节标题加权。
3. 邻近块扩展：命中块前后各 1 块作为 `context`，便于回答"为什么"。
4. 查询范围：给 `textbook_search` 补 `node` / `pageFrom` / `pageTo` 参数（底层已支持 node，只是工具没暴露）。
5. 可选：零命中时用一次小模型做 query 改写（默认关，计入预算）。

**暂不做向量检索**：当前没有 embedding 服务，引入本地模型/向量库会增加体积、隐私面与冷启动成本。先用"结构 + BM25 + 章节范围"，等评测集证明召回不够（recall@5 < 70%）再上。

### 4.5 就地生成与流式（R2）

新增 `src/ai/`：

- `service.ts`：解析默认模型（`agentDefaultModel.currentSelection()`）→ 通过 `llm.prepareCall/stream` 发起调用；模型/适配器不可用时抛 `ai_unavailable`。
- `prompts/`：`guide`、`summary`、`explain`、`translate`、`example`、`quiz`、`grade`、`ask`、`plan`、`report`，每个模板带 `version`。
- `stream.ts`：把 `StreamChunk` 的 `text-delta/usage/finish` 转成 SSE 事件；客户端 `fetch` + `ReadableStream` 消费（不用 EventSource，便于 POST、取消和自定义头）。
- `cache.ts`：`scopeHash = sha256(kind + promptVersion + model + scopeText + instruction)`；命中直接返回 Artifact，不调模型。
- `budget.ts`：调用前估算输入 + `maxTokens`，超过当日预算直接拒绝；调用后按 `usage` 落账。

SSE 事件：

```
event: meta    { taskId, provider, model, scope, estimatedInputTokens }
event: delta   { text }
event: usage   { inputTokens, outputTokens }
event: artifact{ artifactId, citations }
event: done    { status: "ok" }
event: error   { code, message, hint }
```

请求链路：

```
POST /api/books/:id/ai/tasks   → 201 { taskId, streamUrl } 或 { cached: true, artifact }
GET  /api/books/:id/ai/tasks/:taskId/events → text/event-stream
POST /api/books/:id/ai/tasks/:taskId/cancel
```

客户端取消 = abort fetch；服务端监听 `res.close` 并 abort 模型调用。只有 `finish: ok` 才落 Artifact，断流不保存半成品。

任务状态只存内存（含 AbortController），重启即失效；Artifact 与用量落盘。这里不需要为一次性任务引入队列/状态机，断流后重试即可。

### 4.6 产物与学习资产（R0/R2/R4）

新增 `src/store/artifacts.ts`、`quizzes.ts`、`review.ts`，沿用现有原子写 + 书级锁：

```
books/<bookId>/ai/
├── artifacts/<artifactId>.json   # 导读/小结/解释/笔记/术语/报告
├── quizzes/<quizId>.json
├── attempts.json                 # 作答记录
├── review.json                   # 间隔重复卡片
├── evidence.json                 # 自测证据（不覆盖用户自评）
├── usage.json                    # 每日 token 用量
└── threads/<threadId>.json       # 本节问答（可选，R3）
```

关键规则：

- Artifact 保存 `scope`、`citations`、`scopeHash`、`promptVersion`、`model`、`tokens`。
- 树编辑/重新解析导致 `scopeHash` 变化时，旧 Artifact 标记 `stale`，不删除；UI 提示"教材已更新，可重新生成"。
- 用户笔记与 AI 产物同结构，`author: 'user' | 'ai'`；用户可编辑。
- 自测证据单独存，不改写 `progress.mastery`；UI 同时显示"自评"和"自测正确率"。

### 4.7 Agent 工具与提示（R1/R2/R4）

现有 7 个工具保留；`textbook_search` 只加参数，不破坏旧调用。新增工具按里程碑分批：

| 工具 | 里程碑 | 作用 | 关键约束 |
|---|---|---|---|
| `textbook_read` | R1 | 按节/页范围读原文 | 返回 blockId+页码；`maxChars` 默认 6000，最大 20000；`truncated`+`nextCursor` |
| `textbook_context` | R1 | 组装好的上下文包 | 含本节文本、邻接段、疑问、进度；超限明确标注 |
| `textbook_artifact_save` | R2 | 存导读/小结/笔记 | 必须带 citations；校验失败拒绝写入 |
| `textbook_quiz_save` | R4 | 存 Agent 出的题 | JSON 校验；每题必须有真实 `sourceBlockIds` |
| `textbook_quiz_record` | R4 | 记录作答与批改 | MCQ 确定性判分；简答由 Agent 给 rubric 结果 |
| `textbook_review_due` | R4 | 取到期复习卡 | 默认 20 张，按 dueAt |
| `textbook_review_grade` | R4 | 复习评分并排下次 | SM-2 lite；写回 review.json |

**系统提示 v2**（仍放在 `src/prompt.ts`，控制在 15 行内）：

1. 教材事实只能来自工具结果；不要凭记忆补全。
2. 阅读类问题先 `textbook_context`（整节）而不是 `textbook_search`（片段）。
3. 每个事实后给页码引用：对话回答按现有契约拼 `readerUrl` 链接；产物正文写 `[p.N]`。只引用工具返回的真实页码/blockId。
4. 用户要"带我读/精读/复习"时，按"导读 → 逐节 → 小结 → 自测"推进，不要一次倒完整本书。
5. 需要沉淀的产物用 `textbook_artifact_save`；需要练习用 `textbook_quiz_save`。
6. 教材没讲就明确说没讲，并指出可能在哪一节。

**引用格式分两个输出面**：对话回答继续按现有契约拼 Markdown 链接（`[\[p.N\]](readerUrl&page=N&block=ID)`）；就地生成的正文只写 `[p.N]`（需要块级定位时写 `[p.N#blockId]`），宿主校验后生成结构化 `citations`，渲染器再拼内部锚点。`textbook_artifact_save` 两种都接受，统一归一化。这样模型不用记长 URL，也不会把猜的 URL 写进产物。

### 4.8 阅读器交互（R2/R3）

**布局**：左侧目录/进度保留；新增右侧「AI 伴读」栏（可折叠，约 360px；窄窗口变浮层）。标签：导读 / 讲解 / 笔记 / 自测 / 复习。

**章节级**：每个小节的标题旁出现「导读」「小结」「自测」；已有产物显示状态点，不重复生成。

**选区（R3）**：

- 新增「文本视图」切换：按节渲染 `blocks`，每个块是 `<p data-block-id data-page>`，可选中、可复制、可键盘操作。
- 选区工具条：解释 / 翻译 / 举个例子 / 加笔记 / 问 AI。
- 跨块选择：沿 Range 的祖先节点收集 `data-block-id`，把首尾块 + 选中文本发给后端；后端补前后邻接段。
- PDF 文本层（`renderTextLayer` + bbox 交集映射）放到 R5 之后，先解决"能选"再解决"在 PDF 上选"。

**流式卡片**：逐字输出；停止 / 重新生成 / 保存笔记 / 复制；引用渲染成页码 chip，点击在 iframe 内跳页高亮（不整页刷新）。卡片头部显示"基于 3.2 节（pp.45–52）"和模型名，底部显示本次 token。

**安全渲染**：AI 输出是 untrusted Markdown。先转义 HTML，再只解析标题/列表/粗体/引用/代码和 `[p.N]` 链接；禁止原始 HTML 和 `javascript:`。引用链接由结构化 `citations` 生成，不直接信任文本里的 URL。

**空态/错误态**：未启用 → "开启 AI 帮读"引导；无模型 → 指到设置；超额 → 显示今日用量与重置时间；断流 → "已中断，重试"。

### 4.9 成本、隐私、降级

- **默认关闭**，首次开启弹一次性同意：显示将发送的章节范围、字数、provider/model。
- 每次任务显示范围与预估 token；每日预算默认 200k tokens（可调、可关）。
- 只手动触发；不做"打开书就自动总结整本"。
- 日志只记 `task/kind/scope/model/tokens/duration/status`，不记正文。
- 推理模型的 reasoning token 也计入用量；导读/小结默认低 reasoning effort，解释/批改可提高；预算按 `usage` 实际值落账。
- 模型不可用/额度不足/超时：结构化错误 + 可操作 hint；不重试到天荒地老。
- 图片/图表解释仅在模型声明支持图片输入时出现（`resolveModelInfo` 的 `inputModalities`），默认关。

---

## 5. 数据模型（新增）

```ts
type AiTaskKind =
  | 'guide' | 'summary' | 'explain' | 'translate' | 'example'
  | 'quiz' | 'grade' | 'ask' | 'figure' | 'plan' | 'report'

interface AiScope {
  nodeId?: string
  page?: number
  pageFrom?: number
  pageTo?: number
  blockIds?: string[]
  quote?: string
  sectionPath?: string
}

interface AiCitation {
  page: number
  blockId?: string
  label?: string
}

interface AiArtifact {
  version: 1
  id: string
  bookId: string
  kind: AiTaskKind
  title: string
  scope: AiScope
  markdown: string
  citations: AiCitation[]
  author: 'ai' | 'user'
  model?: { provider: string; model: string }
  promptVersion: string
  scopeHash: string
  status: 'ready' | 'stale'
  tokens?: { input: number; output: number }
  warnings: string[]
  createdAt: string
  updatedAt: string
}

interface QuizQuestion {
  id: string
  type: 'single' | 'multiple' | 'short' | 'feynman'
  stem: string
  options?: { id: string; text: string }[]
  answer: string | string[]
  explanation: string
  difficulty: 1 | 2 | 3
  sourceBlockIds: string[]
  sourcePages: number[]
}

interface ReviewCard {
  id: string
  bookId: string
  nodeId?: string
  front: string
  back: string
  source: { page: number; blockId?: string }
  dueAt: string
  intervalDays: number
  ease: number
  lapses: number
  createdAt: string
  lastReviewedAt?: string
}

interface AiSettings {
  enabled: boolean                 // 默认 false，同意后开启
  consent: 'unknown' | 'granted' | 'denied'
  modelOverride?: { provider: string; model: string }
  maxContextChars: number          // 默认 12000
  maxOutputTokens: number          // 默认 1200
  dailyTokenBudget: number         // 默认 200000；0 = 不限制
  cacheEnabled: boolean            // 默认 true
}
```

存储位置：`~/.dsh/textbook-reader/books/<bookId>/ai/`；全局设置进 `config.json` 的 `ai` 字段。沿用 `atomic.ts` 的 tmp+rename 与书级锁。

---

## 6. 接口清单

### 6.1 HTTP（新增）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ai/status` | 模型可用性、provider/model、同意状态、今日用量 |
| POST | `/api/ai/consent` | 记录同意/拒绝 |
| PUT | `/api/config` | 扩展 `ai` 设置（沿用现有接口） |
| POST | `/api/books/:id/ai/tasks` | 创建任务；缓存命中直接回 Artifact |
| GET | `/api/books/:id/ai/tasks/:taskId/events` | SSE 流式结果 |
| POST | `/api/books/:id/ai/tasks/:taskId/cancel` | 取消 |
| GET | `/api/books/:id/ai/artifacts` | 列表（可按 kind/node 过滤） |
| GET/DELETE | `/api/books/:id/ai/artifacts/:artifactId` | 读取/删除 |
| PUT | `/api/books/:id/ai/artifacts/:artifactId` | 编辑用户笔记 |
| GET | `/api/books/:id/ai/quizzes` | 题目列表（生成走 `ai/tasks` 的 `quiz` kind） |
| POST | `/api/books/:id/ai/quizzes/:quizId/attempts` | 提交作答/判分 |
| GET | `/api/books/:id/ai/review` | 到期卡片 / 全部卡片 |
| POST | `/api/books/:id/ai/review/:cardId` | 复习评分 |
| GET | `/api/books/:id/ai/usage` | 用量明细 |

所有写接口继续走现有 loopback/同源守卫；SSE 只允许 loopback/同源。

### 6.2 Agent 工具

见 4.7。工具结果统一返回 `readerUrl`；Artifact 可返回 `readerUrl&artifact=<id>`，让阅读器直接打开对应卡片。

### 6.3 阅读器 URL 扩展

`?book=&page=&block=` 之外增加 `&node=<nodeId>&artifact=<artifactId>&tab=ai`；浏览器半的 `tbr:jump` 消息透传这些字段。

---

## 7. 里程碑

> 估时按单人、熟悉现有代码计算。每个里程碑都必须可独立演示、可回滚（AI 开关关闭即回到 v0.5 行为）。

### R0 · 打地基（2–3 天）

- 新增 `AiSettings`（默认关闭）+ 迁移；`/api/ai/status`。
- ArtifactStore（原子写、列表、删除、stale 标记）+ 测试。
- 引用解析/校验器；Markdown 安全渲染的数据契约。
- `NormalizedCache`（LRU 2 本，按 mtime 失效），避免每次请求重读几十 MB JSON。
- Fake LLM 测试夹具。
- **验收**：`pnpm test` 全绿；关闭开关时行为与 v0.5 完全一致。

### R1 · 看得见整节（4–6 天）

- `context/section.ts`、`chapter.ts`、`budget.ts`、`neighbors.ts`。
- `textbook_read`、`textbook_context`；`textbook_search` 补 node/页范围参数。
- BM25 + 中文分词 + 邻近块扩展。
- 系统提示 v2。
- 评测集 v0：3 本教材 × 10 题，含 3 道"教材没讲"的题。
- **验收**：问"3.2 节讲了什么"能基于整节回答，至少 3 个有效页码引用；不指定页码；检索 recall@5 比现状提升；不新增宿主侧模型调用（仍走对话模型）。

### R2 · 导读与小结（5–7 天，含 2 天技术验证）

- **先做 2 天 spike**：在桌面 profile 里验证 `ctx.get('llm')` + `agentDefaultModel`、一次 200 token 调用、SSE 穿过 webServer、首 token 延迟；过不了就切"Agent 通道优先"的备选方案。
- `AiService`、prompt 模板、SSE、取消、缓存、预算、同意。
- 阅读器右栏 + 章节导读/节末小结 + 流式卡片 + 引用 chip。
- Artifact 列表/打开/删除；`artifact=` 深链。
- **验收**：点一次"本章导读"→ 首 token 可见 → 结果覆盖全部小节并带页码 → 重开命中缓存 → 重启后仍在 → 关闭开关后按钮消失。

### R3 · 就问这段（5–7 天）

- 文本视图（按节渲染、块级 `data-block-id`、可选中）。
- 选区工具条：解释/翻译/举例/提问/加笔记。
- 本节问答线程（3–5 轮，带本节上下文，无工具）。
- 产物保存为笔记；笔记列表。
- 可选：图片解释（仅多模态模型）。
- **验收**：选中一段 → 解释含原文引用 → 可追问一轮 → 笔记保存并在"笔记"页出现；全程不离开阅读器。

### R4 · 会了没（6–9 天）

- 就地出题（严格 JSON + 校验 + 失败重试一次）。
- 自测 UI：单选/多选/简答/费曼；MCQ 确定性判分，简答 rubric。
- 作答记录 + 证据（正确率、最近作答）；与自评掌握度并列展示。
- 错题本；复习卡（SM-2 lite：1/3/7/16/35 天）；每日复习队列。
- Agent 工具：`textbook_quiz_save/record`、`textbook_review_due/grade`。
- **验收**：一节生成 5 题 → 作答 → 得分 → 错题进入复习 → 重启后到期卡片仍在 → 证据页可见。

### R5 · 陪读完一本（5–7 天）

- 阅读计划：按章节页数 + 每日分钟数排期；今日目标；落后自动顺延。
- 周报：本地统计 + 一次 AI 叙述（带章节引用）。
- 术语表/概念卡：按章抽取，可编辑，文本视图内首次出现可点。
- 导出：整本 Markdown 包；复习卡 Anki TSV。
- 可选：`教材精读` agent preset / skill；工具调用卡片美化。
- 可选实验（不进主路径、默认关）：随读模式（翻页触发 1 句导读 + 1 个自检问题，节流 + 缓存）、苏格拉底追问（学完一节连续问 3 轮，诊断误解）、文本视图内联高亮关键句。
- **验收**：8 章教材生成 14 天计划；今日目标可跳转；周报有引用；导出可打开。

### R6 · 打磨交付（3–4 天）

- 空态/错误态/无障碍/窄窗口/i18n 基线。
- 性能：文本视图只渲染当前节；Artifact 懒加载。
- 文档、截图、验收矩阵、版本号 0.6–1.0、桌面端安装验证。
- 真实 MinerU token 下的 3 本真教材评测（与解析质量一起验）。
- **验收**：ACCEPTANCE 逐条有证据；评测集引用合法率 100%；无静默失败。

**总估时**：30–43 人天（单人约 6–8 周；聚焦 R1+R2+R3 约 3–4 周）。

---

## 8. 第一个垂直切片（建议立刻做）

目标：**打开一章 → 点"导读" → 流式出现带页码的导读 → 保存 → 重开命中缓存。** 这是"AI 帮读"的最小可信闭环。

### 第 1 周

| 天 | 工作 |
|---|---|
| D1 | Spike：宿主 `llm` + 默认模型 + SSE + 首 token 延迟；记录结论 |
| D2 | `AiSettings`、ArtifactStore、引用校验器、Fake LLM |
| D3–D4 | 上下文构建器（section/chapter/budget）+ 单测 |
| D5 | `textbook_read` / `textbook_context` + 系统提示 v2 |
| D6–D7 | BM25 检索 + 评测集 v0 + 基线数据 |

### 第 2 周

| 天 | 工作 |
|---|---|
| D8–D9 | `AiService` + 导读/小结 prompt + SSE + 取消 + 预算 |
| D10–D11 | 阅读器右栏 + 导读卡 + 流式渲染 + 引用跳转 |
| D12 | 缓存、同意、设置、用量展示 |
| D13 | E2E：重启、断流、无模型、关闭开关 |
| D14 | 演示 + 数据复盘 + 调整 R3 范围 |

### 完成定义（DoD）

- 首 token P50 ≤ 2.5s（本机默认模型实测；不达标先查上下文大小与 maxTokens）。
- 导读覆盖本章所有小节，引用 ≥3 个且全部可跳转。
- 缓存命中时 200ms 内返回；重启后 Artifact 仍在。
- 无模型/未同意/超额三种情况都有可操作提示。
- `pnpm test` 新增 ≥15 个用例，全部离线可跑。

---

## 9. 质量与评测

### 9.1 测试

- **单元**：context 预算/截断/排序、引用校验、Artifact 原子写、SM-2、quiz JSON 校验、Markdown 安全渲染。
- **集成**：Fake LLM 注入 `AiService`，覆盖 SSE 分帧、取消、缓存命中、预算拒绝、模型缺失、断流不落盘。
- **E2E**（playwright-core 已有）：导读流式渲染、引用跳页、文本选区、自测提交、重启持久化。
- **回归**：关闭 AI 时所有旧测试与行为不变。

### 9.2 评测集

`eval/`（不随插件发布）：

- 3 本真教材（含 1 本 OCR 质量差的），每本 10 题：事实题、概念题、跨节题、不可回答题。
- 真实教材依赖 MinerU token；token 未到位时先用 420 页合成书 + fixture 跑引用/截断/拒答，真教材指标在 R6 补。
- 指标：引用合法率、引用相关性（人工 1–5）、recall@5、拒答正确率、首 token 延迟、单任务 token。
- 每次改 prompt/检索/上下文都跑一次，记录在 `eval/report.md`。

### 9.3 硬门槛

- 引用合法率 **100%**（自动化：每个链接的 page/block 必须存在）。
- 不可回答题拒答率 **≥90%**。
- 单任务输出不超过 `maxOutputTokens`；日预算拒绝率 100% 生效。
- 关闭开关时外发请求数 = 0（沿用现有外发审计测试）。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 桌面 profile 拿不到 `llm`/默认模型 | 就地通道不可用 | R2 先 spike；失败则切 Agent 通道优先，导读改为"对话生成 + Artifact 落盘" |
| 长章节超上下文 | 截断、答不全 | 章级用骨架；节级超限先分块摘要再合并；UI 明确"已省略" |
| 模型幻觉/错引 | 信任崩塌 | 引用校验器、先引原文再解释、拒答训练、评测集 |
| OCR/公式质量差 | 解释基于错字 | 展示原文块；标注"解析可能有误"；允许用户选中修正后提问 |
| 费用/额度失控 | 用户不敢用 | 默认关、手动触发、缓存、maxTokens、日预算、用量可见 |
| 首 token 慢 | 不像"帮读" | 小 scope、流式、骨架导读、取消/重试 |
| 双入口混乱 | 不知道去哪问 | 就地栏标注"本节问答"；共享 Artifact；深链互通 |
| 树编辑/重解析使缓存失效 | 旧导读对不上 | `scopeHash` + `stale` 标记，不静默复用 |
| 文本视图 420 页卡顿 | 体验差 | 按节渲染 + 虚拟列表；PDF 视图保持现状 |
| DSH `llm` 契约变化 | 升级即坏 | 只依赖 `prepareCall/stream` 最小面；feature detect；记录测试版本 |

---

## 11. 明确不做（本路线图内）

- 向量库 / embedding 基础设施（等 recall 数据说话）。
- 整本书一键总结、整本翻译、后台批量预生成所有章节。
- 本地模型 / 本地 MinerU。
- EPUB、多书对照、习题自动判分（学校题库那种）。
- 图注 VLM 默认开启、自动把整本图片外发。
- AI 主动在聊天里插话/推送（复习提醒另行评估）。

---

## 12. 需要你拍板的三件事

1. **是否允许宿主直接调用默认模型？**（推荐：允许。否则只能做"对话增强"，做不到"阅读器里点一下就地讲解"。代价是消耗你的模型额度，用预算和同意弹窗控制。）
2. **首批场景顺序？**（推荐：1) 导读/小结 → 2) 选区讲解 → 3) 自测/复习 → 4) 整章对话。1 最能立刻体现"AI 帮读"，3 最能体现"读完了"。）
3. **AI 默认开还是关？**（推荐：默认关 + 首次开启同意。发给模型的内容和范围每次都可见。）

拍板后，下一步直接从 **R0 + R1** 开始；R2 的第一件事是 2 天 spike，先验证再投入。
