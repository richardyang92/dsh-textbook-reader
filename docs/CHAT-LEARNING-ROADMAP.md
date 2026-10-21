# 聊天式 AI 伴读：v2 升级方案

> 日期：2026-10-20 · 基线：v0.5.0 · 参考形态：截图中的「内容在左、AI 聊天在右」
> 结论：这不是给阅读器再加几个按钮，而是把**聊天变成主界面**。推荐做成「教材阅读器（左）+ 常驻 AI 陪伴聊天（右）」的双栏工作台，聊天背后是**每本书一个真正的 DSH Agent 会话**，不是另一个小模型。

> 前提说明：本方案针对「教材伴读插件里的常驻聊天侧栏」，不覆盖「任意网页上的独立浏览器扩展侧栏」（那需要单独的扩展与 DSH 通信）。

---

## 1. 为什么是"大升级"

| 维度 | 现在（v1 路线图） | 目标（v2） |
|---|---|---|
| 交互 | AI 是阅读器里的按钮：导读/解释/出题 | 聊天是主界面，阅读器是上下文；按钮变成快捷 prompt |
| 智能 | 宿主单次 `llm` 调用，无工具、无多轮 | 真正的 DSH Agent：多轮、工具、检索、流式、可取消 |
| 记忆 | 每次生成即结束，靠 Artifact 留痕 | 每本书一个会话，聊天历史随书保存，重启/换书不丢 |
| 产物 | 卡片式导读/笔记 | 聊天的自然产物：笔记、题目、复习卡，仍可落盘 |
| 上下文 | 用户描述"第 87 页第 2 段" | 阅读器自动带入当前章/节/页/选区，用户不用解释 |

一句话：**从"AI 工具"升级为"AI 陪读老师"**。聊天是入口，阅读器是教材，工具是老师的手，Artifact 是老师的板书。

---

## 2. 目标形态

```
┌───────────────────────────────────────────────┬──────────────────────────┐
│  教材阅读器（现有 iframe）                     │  AI 伴读（常驻聊天）      │
│  ┌─────────┬─────────────────────────────┐    │  《深度学习》· 3.2 反向传播│
│  │ 目录/   │  PDF / 文本视图              │    │  ─────────────────────   │
│  │ 进度    │  （可选中、可高亮）           │    │  AI: 这节先抓住…… [p.87] │
│  │         │                             │    │  你: 为什么用链式法则？   │
│  │         │                             │    │  AI: 正在读 3.2 节……     │
│  └─────────┴─────────────────────────────┘    │  ─────────────────────   │
│                                               │  [导读] [解释选中] [考考我]│
│                                               │  ┌─────────────────────┐ │
│                                               │  │ 输入问题…      发送 │ │
│                                               │  └─────────────────────┘ │
└───────────────────────────────────────────────┴──────────────────────────┘
```

**典型学习流**

1. 打开教材 → 右侧聊天自动出现：「想怎么读？[3 分钟导读] [从上次继续] [先测测水平]」。
2. 点「导读」→ 聊天里流式出现本章地图，带页码；可点 `[p.45]` 跳回。
3. 读的时候选中一段 → 阅读器浮出「问 AI」→ 聊天自动带入原文，回答后继续追问。
4. 学完一节 → 输入「考考我」→ AI 出 5 题，用户答，AI 判分并解释。
5. 说「记下来」→ 保存为笔记；下次打开书，聊天历史和笔记都在。
6. 想用完整 DSH 对话 → 「在对话中打开」跳到同一个会话，历史不分裂。

**"Kimi 式"的关键不是 UI 长得像，而是四件事**：常驻、自动带上下文、能连续追问、答案能回到原文。

---

## 3. 关键发现：DSH 已经给了什么

我查了当前 DSH 0.2.0-rc.2 的服务与槽位目录，以下能力决定了方案可行性：

1. **宿主可以直接驱动真实 Agent**：`ctx.agents.create/resume` 返回 `AgentHandle`；`agent.followup({content})` 投递用户消息，`agent.cancel()` 取消，`agent.whenIdle()` 等待空闲；`agent/assistant-stream` 事件提供逐块文本/工具调用帧。`sessionController` 只是把这些能力包装成给 UI 的 Remote，插件用 `ctx.agents` 更直接。
2. **会话就是真 Agent**：它自动拥有模型、系统提示、工具、压缩、持久化。教材工具 `textbook_*` 是全局注册的，书籍会话能直接调用。
3. **右侧栏有 session 级聊天槽位**：`rightbar` / `sidebar.right.pane.tab` 的标准 props 含 `sessionId`、`useChat`、`useConversation`、`inputActions`；原生侧栏聊天技术上可行。
4. **但"打开指定右侧栏 tab"的公开控制器不明确**：`layout.openRightbar` 只能打开栏，不能可靠选中某个 tab。把产品首版押在这上面风险偏高。
5. **主面板没有 session 绑定**：`main` 槽位拿不到"当前会话 id"。所以不能简单地说"在阅读器里聊当前会话"。
6. **Agent 作用域可以定制**：`agents.create({ setup(agentCtx, agent) })` 里可以做 agent 级 `tools.restrict({ allow: [...] })` 和 `systemPrompt.section(...)`，不用 YAML preset 也能实现"只给教材工具 + 导师提示"。

**结论**：

- **推荐 A（先做）**：阅读器主面板改成左右双栏，右侧是自绘聊天面板；聊天背后是**每本书一个 Agent**——宿主用 `ctx.agents.create/resume` 建/恢复，`agent.followup` 投递消息，监听 `agent/assistant-stream` 转 SSE。可控、可交付、不依赖未公开的 tab 控制器。
- **后续 B（增强）**：把同一个聊天面板注册成原生右侧栏 tab，用平台 `useChat/useConversation` 渲染，减少自绘 UI。等 A 验证后再评估。
- **不做 C**：在阅读器里自建一个迷你 LLM 循环（prompt + 工具手写）。这会把 Agent 的模型选择、压缩、持久化、工具执行全部重做一遍，长期维护成本最高。

> 第 1 条是**方案成立的关键假设**，必须先做 3 天 spike 验证（见 C0），不能直接开工 UI。

---

## 4. 架构

```
┌──────────────────────────── Reader iframe ────────────────────────────┐
│ 现有 pdf.js 阅读器、章节树、进度、文本视图/选区                        │
│  → postMessage: 当前书/节/页/选区；← postMessage: 跳页/高亮            │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ postMessage
┌───────────────────────────────▼───────────────────────────────────────┐
│ Client main panel（React）                                             │
│  SplitLayout: [ReaderPane iframe] [ChatPanel]                          │
│  ChatPanel: 消息列表 / 流式 / 工具活动 / 引用 chip / 输入框 / 快捷动作   │
│  SSE 客户端、引用跳转、笔记保存、在对话中打开                            │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ HTTP + SSE（同源、loopback guard）
┌───────────────────────────────▼───────────────────────────────────────┐
│ Host plugin：ChatBridge                                               │
│  ensureSession(book)   ctx.agents.create/resume + scoped setup         │
│  sendMessage(book,text,context)  agent.followup({content})             │
│  followEvents(agent)  agent/assistant-stream → ChatEvent SSE           │
│  history(sessions.get) / cancel / reset / rename                       │
│  reading-state.json / 笔记 Artifact / 会话 id 持久化                    │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ Host service
┌───────────────────────────────▼───────────────────────────────────────┐
│ DSH Agent（每本书一个，插件持有 AgentHandle）                           │
│  模型 / 系统提示 / textbook_* 工具 / 压缩 / 会话持久化                   │
└───────────────────────────────────────────────────────────────────────┘
```

**与 v1 路线图的关系**：上下文构建、BM25 检索、`textbook_read/context`、Artifact、Quiz/Review、评测与风险仍然有效，作为聊天方案的地基；v1 的"宿主 `llm` 单次生成 + 卡片"不再是主路径，降级为可选的"内联快捷解释"（见 C5）。

---

## 5. 会话模型

### 5.1 一本书一个会话

- 首次打开某本书的聊天时，`ensureSession(book)`：
  - 读 `books/<id>/ai/chat.json` 的 `sessionId`；
  - `ctx.agents.get(id)` 已活 → 复用现有 `AgentHandle`；
  - 存在但未活 → `ctx.agents.resume({ resumeSessionId })`；
  - 不存在/恢复失败 → `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup })`，写回 `chat.json`；
  - 标题用 `sessionController.rename`（best effort，失败不影响聊天）。
- 好处：聊天历史天然按书隔离；换书即换 Agent；重启可恢复；用户也能在 DSH 侧栏看到同一会话。
- 代价：每本书会在 DSH 侧栏多一个会话。缓解：会话标题带书名；删除书时归档会话；后续可建一个"教材伴读" workspace 收纳。
- 备选（不推荐首版）：用"当前会话"。主面板拿不到当前会话 id，且教材学习会混进编码会话；除非后续做右侧栏 tab 方案。

### 5.2 会话权限与工具面

- **不靠 YAML preset 也能做**：`ctx.agents.create({ setup(agentCtx, agent) })` 里直接做 agent 级注册：
  - `agentCtx.tools.restrict({ allow: TEXTBOOK_TOOL_NAMES })`；
  - `agentCtx.systemPrompt.section({ name, order, text: TUTOR_GUIDANCE })`；
  - 这些注册随 agent 生命周期释放，不影响其他会话。
- `restrict` 的 `allow` 是**精确名字**，未知名字会失败；因此创建前用 `ctx.tools.schemas()` 求交集，只传当前真实存在的教材工具。
- **硬理由**：自绘聊天面板不承载 DSH 的工具审批/用户提问 composer。若 Agent 触发 `bash`/`write` 等需要审批的工具，审批弹窗出现在 DSH 对话界面而不是阅读器聊天里，用户看不到，回合会挂起。因此书籍会话应限制为**不需要审批的教材工具**（`textbook_*`），这不只是安全偏好。
- 模型：`agentOptions` 用 `agentDefaultModel.currentSelection()`；不可用时返回 `model_missing`，不创建半配置 Agent。
- 后续：把同一套 setup composition 抽成 `教材精读` preset，便于用户在新会话里直接选；首版先用 setup 内联，少一层配置。

### 5.3 会话 id 与数据

```
books/<bookId>/ai/
├── chat.json          # { version, sessionId, title, createdAt, lastSeq }
├── reading-state.json # 当前节/页/选区/进度（供 UI 与工具读）
└── notes/<id>.json    # 聊天里"保存为笔记"的产物（沿用 Artifact 结构）
```

会话正文不复制到插件：它属于 DSH session store；插件只存 id 和阅读状态。这样不会出现"两份聊天记录"。

---

## 6. 聊天协议与接口

### 6.1 ChatEvent（宿主 → 浏览器 SSE）

```ts
type ChatEvent =
  | { type: 'snapshot'; messages: ChatMessage[]; cursor: number }
  | { type: 'user'; message: ChatMessage; seq: number }
  | { type: 'assistant-start'; turn: number; step: number }
  | { type: 'assistant-delta'; text: string; turn: number; step: number }
  | { type: 'assistant'; message: ChatMessage; usage?: { input: number; output: number } }
  | { type: 'tool'; status: 'start' | 'end'; name: string; summary: string }
  | { type: 'turn-end'; reason: 'completed' | 'aborted' | 'error' | 'max-tokens'; message?: string }
  | { type: 'error'; code: string; message: string; hint?: string }
  | { type: 'cursor'; seq: number }

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string          // markdown；引用为 [p.N] 或 reader 链接
  seq: number
  createdAt: string
  citations?: { page: number; blockId?: string }[]
  pending?: boolean      // 仅流式占位
}
```

- `snapshot` 打开时先发；客户端带 `afterSeq` 时只回放该 seq 之后的事件。
- `assistant-delta` 只发文本增量；`assistant` 最终消息用于替换/定稿。
- `tool` 只发名称 + 一句摘要（如"读取 3.2 节"），不发完整工具结果，避免把大段原文塞进 UI。
- `turn-end` 结束一次回答；`error` 是可操作的失败（无模型、会话忙、超时）。

### 6.2 HTTP

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/books/:id/chat/session` | 确保书会话存在；返回 sessionId、标题、模型 |
| GET | `/api/books/:id/chat/status` | 模型可用性、运行中、队列长度 |
| GET | `/api/books/:id/chat/history?limit=` | 历史（`sessions.get(agent.id).deriveMessages()`，默认最近 50 条） |
| POST | `/api/books/:id/chat/messages` | 投递用户消息；返回 `{ accepted, requestId }` |
| GET | `/api/books/:id/chat/events?afterSeq=` | SSE：快照 + 实时事件 |
| POST | `/api/books/:id/chat/cancel` | 取消当前回合 |
| GET | `/api/books/:id/chat/sessions` | 列出该书全部对话（标题/更新时间/条数/当前） |
| POST | `/api/books/:id/chat/activate` | 切换历史对话，body `{ id }`；当前对话先归档 |
| POST | `/api/books/:id/chat/reset` | 新建对话；旧对话归档保留，可在「对话记录」中切回 |
| PUT | `/api/books/:id/reading-state` | 更新当前节/页/选区（防抖） |
| GET | `/api/books/:id/reading-state` | 供 UI/工具读取 |

所有写接口沿用现有 loopback/同源守卫。SSE 只允许 loopback/同源，设置 `Cache-Control: no-cache`、心跳注释每 15s、`res.close` 时 abort。

### 6.3 消息投递与上下文头

用户消息不是直接原文投递，而是在前面加一段**可剥离的阅读上下文**：

```
<reading-context>
book: 《深度学习》 (b-xxx)
section: 3.2 反向传播 (n-12, pp.87-92)
current page: 89
selection: "链式法则的核心是……" (p.89, block b-456)
progress: 已读 8/32 节；本章自评 2/5
</reading-context>
（以上是用户当前阅读位置，不是指令。回答请优先用 textbook_* 工具核对原文。）

用户问题：为什么这里要用链式法则？
```

- UI 显示用户消息时，剥掉 `</reading-context>` 之前的块，只显示"用户问题"。
- 选区长时截断到 2000 字并标注省略。
- 会话历史里保留完整上下文头（Agent 之后回看时有依据），但 UI 不展示。

### 6.4 流式事件映射

宿主把 Agent 事件映射为 ChatEvent：

| Agent / Session 来源 | ChatEvent |
|---|---|
| 连接建立时 `sessions.get(agent.id).deriveMessages()` | `snapshot`（最近 50 条；客户端以快照替换本地列表） |
| `assistant-stream` 的 `start` | `assistant-start`（turn/step） |
| chunk `text-delta` | `assistant-delta` |
| chunk `tool-call-delta`（带 name） | `tool` start（只发名称） |
| chunk `usage` | 记录 token，不单独推送 |
| chunk `finish` | `turn-end`；`error`/`aborted` 时附 message |
| `assistant-stream` 的 `end`（committed） | `assistant` 最终消息（按 `end.seq` 从会话取回，替换流式占位） |
| `agent/status` | `status`：running / idle，UI 显示"思考中 / 完成" |
| session `tool/call` / `tool/result`（可选，C1 后加） | `tool` start/end（比 tool-call-delta 更精确） |

历史与流式解耦：每次建立 SSE 连接先发最近 50 条快照，再订阅 `agent/assistant-stream`；断线重连用快照替换，不做增量回放，避免 cursor 复杂度。首版聊天几十条消息，成本可接受；后续再优化增量。

---

## 7. 聊天 UI

### 7.1 布局

- 主面板 `TextbookPanel` 从"全屏 iframe"改成 `SplitLayout`：
  - 左：现有 reader iframe；右：`ChatPanel`（默认 380px，可拖拽，可折叠）。
  - 窄屏（< 1100px）：聊天变成覆盖式抽屉；阅读器目录自动折叠。
- 聊天区沿用 DSH 主题 token；不引入第二套设计系统。
- 阅读器 iframe 与 ChatPanel 用 postMessage 通信：
  - `tbr:context`：书、节、页、选区（节流 300ms）。
  - `tbr:ask`：快捷动作（解释选中/总结本节/考考我）。
  - `tbr:jump`：引用点击跳页/高亮（现有逻辑复用）。
  - `tbr:sidebar`：聊天打开时折叠阅读器左栏，给 PDF 让宽度。

### 7.2 聊天面板组成

1. **头部**：书名 + 当前节 + 模型/状态 + 「新会话」「在对话中打开」「折叠」。
2. **上下文条**：`3.2 反向传播 · p.89`；有选区时显示 `已选中 120 字`，可清除。
3. **快捷 prompt**（空态/常驻底部）：`3 分钟导读`、`解释选中`、`总结本节`、`考考我`、`制定阅读计划`。
4. **消息列表**：
   - 用户气泡（剥离上下文头）；
   - 助手 Markdown：标题/列表/粗体/代码/引用；`[p.N]` 转页码 chip；
   - 工具活动行：`正在读取 3.2 节…`、`已检索 5 条`；失败显示错误；
   - 流式光标；停止按钮；重新生成（重新投递上一条用户消息）。
5. **输入区**：多行输入、Enter 发送 / Shift+Enter 换行、发送/停止、附件（后续）、字数提示。
6. **消息操作**：复制、保存为笔记、引用跳转、反馈（赞/踩，先本地）。
7. **空态/错误态**：未打开书、未配置模型、会话忙、断流、额度不足。
8. **历史**：打开时加载最近 50 条；上滑加载更早；滚动位置保持。

### 7.3 引用与跳转

- 助手消息里识别两类引用：
  - Markdown 链接 `.../textbook-reader/?book=...&page=N&block=ID`；
  - 纯文本 `[p.N]` / `[p.N#blockId]`（在本书页数范围内才转链接）。
- 点击 → `postMessage({type:'tbr:jump', page, blockIds})` → 阅读器滚到页并高亮。
- 非法页码不转链接，保持纯文本；不猜页码。

### 7.4 安全渲染

- AI 输出是不可信 Markdown：先转义 HTML，只解析白名单语法；禁止原始 HTML、`javascript:`、外链图片。
- 引用链接由结构化 page/block 重建，不直接信任模型给的 URL。
- 工具活动只显示名称与摘要，不把工具结果原文渲染进 UI。

---

## 8. 教学法：让聊天真的"帮读"

普通问答不是"伴读"。聊天需要一套稳定的教学循环，写进系统提示 / preset：

1. **定位**：先确认书、节、页、选区（上下文头 + `textbook_reading_state`）。
2. **诊断**：先问一句"你卡在哪/想先理解什么"，或给一个 30 秒的小检查。
3. **讲解**：短段落、分点、先直觉后形式；每个事实带页码；先引原文再解释。
4. **检查**：讲完一个概念，问一个具体问题；用户答错就换角度，不重复原话。
5. **练习**：用户说"考考我"时出题，先不给答案；答完再判分+解释。
6. **记录**：用户说"记下来"时保存笔记/题目；结束时给"下一步读哪"。

**模式**（可以作为快捷 prompt，不必做复杂 UI）：

- `导读`：本章地图、前置知识、阅读路线、3 个读完后应能回答的问题。
- `精读`：逐段解释、术语、例子、常见误解。
- `出题`：5 题（单选/简答/费曼），先题目后答案。
- `复习`：错题、薄弱点、间隔重复。
- `翻译`：选中段落对照翻译（默认不整本翻译）。

**导师提示词要点**：

- 不要一次倒完整章；先给地图，再按用户选择展开。
- 教材没讲就明确说没讲，并指出可能在哪一节。
- 每个事实后给页码；不确定就说不确定。
- 用户答错时先肯定对的部分，再指出一个具体偏差。
- 回答默认用用户语言；控制长度，聊天不是讲义。

**工具映射**：

| 用户意图 | Agent 工具 |
|---|---|
| "这页/这段讲什么" | `textbook_reading_state` + `textbook_read` |
| "这章讲什么" | `textbook_context`（章级骨架） |
| "帮我找…" | `textbook_search` + 邻近块 |
| "记下来" | `textbook_artifact_save` |
| "考考我" | `textbook_quiz_save`（C4） |
| "我读到哪了" | `textbook_reading_state` / `textbook_progress` |

---

## 9. 里程碑

> 估时按单人、熟悉现有代码。每个里程碑可独立演示，失败可回退到 v0.5（双栏关闭、聊天入口隐藏）。

### C0 · 会话桥 spike（3–5 天）——先验证再投入

> **C0 ✅ PASS（2026-10-21，v0.6.0-dev.5）**：`spawn` 子 Agent + `follow` 完整跑通。实测 154s、31 个 step，真实调用 `textbook_list/progress/tree/search` 与 bash，最终产出 966 字回答、9 个可点击页码引用，`turn-end completed`。结论：模型/连接/流式/历史/引用链路成立。
>
> **C1 ✅ 代码完成（v0.6.0-dev.7，live UI 修复中）**：主面板「左 reader + 右聊天」；reader 用 `tbr:context` 上报书/页/节，聊天接 SSE 快照/流式/工具活动/引用 chip/快捷 prompt/停止/新会话；`textbook-tutor` preset 已注册。live 截图暴露五处：①嵌入时 900px 断点把侧栏堆到顶部 → 改为**抽屉式侧栏**（默认收起，PDF 全宽，新增「目录」按钮）；②`.pdf-scroll` 缺 `min-height:0` → 补上；③父面板 iframe ref 晚于 reader 首次上报 → `tbr:ping` 时重发 context；④收起聊天后唯一入口是右下角悬浮「AI」按钮，被 `dsh-whale-widget`（z-index 9999）完全遮住，聊天无法再唤出 → 收起态改为**阅读器顶栏的线性聊天图标**（与书架/刷新同款 ghost icon，父面板用 `tbr:chat-state` / `tbr:chat-open` 同步显隐），既不会被右下角挂件遮挡，也不会压住阅读器自带的刷新按钮；⑤「新对话」会覆盖 `transcript.json`，旧会话只剩 DSH 内部历史、UI 不可见 → 每本书新增 `ai/history.json` 会话索引与 `ai/history/<id>.json` 归档，聊天头部加「对话记录」可切换旧会话，旧单会话数据首次读取自动迁移。54 项测试通过，刷新页面验收。

- 在桌面 profile 里写一个一次性脚本/临时路由，验证：
  1. `ctx.agents.create({ sessionId, agentOptions, setup })` 能否从宿主创建 Agent，`resume({ resumeSessionId })` 能否恢复；
  2. `agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } })` 能否投递消息；
  3. `agent/assistant-stream` 能否逐块拿到 `start`、`text-delta`、`tool-call-delta`、`finish`、`end`；
  4. `setup` 里的 `agentCtx.tools.restrict({ allow })` 与 `systemPrompt.section` 是否生效（只看到 `textbook_*`、导师提示存在）；
  5. `sessions.get(agent.id).deriveMessages()` 能否取到历史；重启后 `resume` 历史是否还在；
  6. 会话是否出现在侧栏、标题是否可改、首 token/工具延迟、`cancel` 是否生效。
- **Gate**：`create` + `followup` + `assistant-stream` + `restrict` + `resume` 全部通过 → 按本方案；任一不可用 → 切备选（见 12），先不做 UI。
- 产出：`docs/SPIKE-CHAT-BRIDGE.md`（结论 + 最小代码 + 事件样例）。

### C1 · 双栏聊天 MVP（5–7 天）

- `SplitLayout`：reader iframe + ChatPanel；折叠/拖拽/窄屏抽屉。
- ChatPanel：历史、流式、Markdown、引用 chip、工具活动、输入/停止、错误态。
- 宿主 ChatBridge：ensureSession、followup、assistant-stream→SSE、history、cancel、status。
- `chat.json`、`reading-state.json`；重启恢复。
- **验收**：打开书 → 聊天 → "用三句话介绍这一节" → 工具活动可见 → 回答带页码 → 点击跳回 → 重启历史还在。

### C2 · 阅读上下文与快捷动作（4–6 天）

> **选区与「解释选中」✅（v0.6.0-dev.8）**：阅读器用 MinerU block 的 bbox 生成透明可选文本层（不依赖 PDF 内置文本层，扫描版同样可选），选区经 `tbr:context` 带入聊天，`tbr:ask` 唤起聊天并预填，`tbr:clear-selection` 清除；host 的 `<reading-context>` 已包含页码/页码范围与 blockId。仍待补：`textbook_reading_state` 工具与完整阅读状态落盘。

- 阅读器 postMessage：书/节/页/选区；防抖；阅读状态落盘。
- 上下文条 + 选区 chip；`tbr:ask` 快捷动作（解释选中/总结本节/考考我/导读）。
- `textbook_reading_state` 工具；系统提示 v2（导师流程、引用、拒答）。
- 引用跳转；"在对话中打开"同一会话；会话标题。
- **验收**：选中一段 → 点"解释" → 聊天自动带入原文并回答；问"我读到哪了"正确；换书切会话。

### C3 · 导师模式与学习资产（5–7 天）

- "教材精读" agent preset：限制工具面、注入导师提示、可选默认模型。
- `textbook_context` / `textbook_read` / `textbook_artifact_save` 三件套（把 v1 的 R1 落进来）。
- 聊天内"保存为笔记"；笔记列表/打开；导读/小结作为快捷 prompt。
- 会话内"考考我"先出题；题目保存为 Artifact（C4 再做判分/复习）。
- **验收**：导读覆盖全章小节；笔记保存后重启可见；会话工具面符合 preset；教材外问题明确拒答。

### C4 · 出题、判分与复习闭环（6–9 天）

- 出题 Artifact：单选/多选/简答/费曼；严格 JSON 校验；来源 block 校验。
- 判分：MCQ 确定性，简答 rubric；作答记录 + 证据（不改写用户自评）。
- 错题本；复习卡（SM-2 lite）；每日复习队列；"考考我"接复习。
- Agent 工具：`textbook_quiz_save/record`、`textbook_review_due/grade`。
- **验收**：5 题 → 作答 → 判分 → 错题进复习 → 重启后到期卡片仍在。

### C5 · 打磨、内联快捷解释与交付（5–7 天）

- 内联快捷解释（可选）：选中 → 浮层短解释，走宿主 `llm` 单次调用，不污染聊天；失败回退到聊天。
- 模型选择/状态、用量提示、会话归档、删除书时清理会话。
- 响应式/无障碍/性能（长历史、420 页、SSE 重连）。
- 评测集：3 本教材 × 10 题；引用合法率、拒答率、首 token、工具轮数。
- 文档、截图、验收、版本号、桌面端安装验证。
- **验收**：ACCEPTANCE 逐条有证据；关闭聊天入口时行为回到 v0.5。

**总估时**：28–41 人天（单人约 6–8 周；C0+C1+C2 约 3 周可演示核心形态）。

---

## 10. 第一个垂直切片（建议立刻做）

目标：**打开一本书 → 右侧聊天 → 问"这章讲什么" → Agent 调工具读章节 → 流式回答带页码 → 点击跳回 → 重启历史还在。**

| 天 | 工作 |
|---|---|
| D1–D3 | C0 spike：agents.create/resume、followup、assistant-stream、cancel、工具限制、标题、重启、延迟；写结论 |
| D4–D5 | ChatBridge 骨架：session 持久化、上下文头、事件映射、SSE、fake 测试 |
| D6–D7 | SplitLayout + ChatPanel 最小版：历史/流式/输入/错误 |
| D8–D9 | 引用 chip + 跳转；工具活动；停止/重试；重启恢复 |
| D10 | 阅读状态 + 选区上下文；快捷 prompt |
| D11–D12 | 系统提示 v2 + 教材精读 preset（或工具限制） |
| D13 | 评测 10 题；记录引用合法率、首 token、工具轮数 |
| D14 | 演示 + 复盘；决定 C3/C4 顺序 |

**DoD**：首 token（含工具）可感知地流式；引用 100% 可跳；重启/换书会话正确；无模型/断流/取消都有明确提示；`pnpm test` 新增 ≥12 个离线用例。

---

## 11. 与 v1 路线图的关系

| v1 内容 | v2 处置 |
|---|---|
| R0 配置/Artifact/引用校验/NormalizedCache | 保留，C1 直接用 |
| R1 上下文构建、BM25、`textbook_read/context` | 保留，C3 落地；聊天质量的地基 |
| R2 宿主 `llm` 单次生成 + SSE + 预算 | 降级为 C5 可选内联解释；不再做卡片主路径 |
| R3 文本视图/选区/本节问答 | 文本视图/选区保留（C2）；"本节问答"升级为双栏聊天（C1/C2） |
| R4 自测/复习 | 保留，C4 |
| R5 计划/周报/术语表 | 保留，C5 之后按需 |
| R6 打磨交付 | 合并进 C5 |

**建议顺序**：C0（3 天 spike）→ C1（双栏 MVP）→ C2（上下文/快捷动作）→ 并行补 R1 的上下文/检索 → C3 → C4 → C5。不要先做一堆卡片再改聊天，返工最大。

---

## 12. 风险与降级

| 风险 | 影响 | 对策 |
|---|---|---|
| `ctx.agents.create/followup` 在宿主侧不可用 | 方案不成立 | C0 gate；备选 1：改用 `sessionController` Remote 或客户端驱动；备选 2：宿主 `llm` 迷你循环（成本最高） |
| `PromptContentPart` 形状不确定 | 无法投递消息 | C0 用 `admitPromptContent`/类型/实测确认；必要时用最简 text part |
| 新会话不自动带教材工具/提示 | 回答无依据 | C0 验证；否则在首条消息注入工具清单/提示，或调整 composition |
| 每本书一个会话让侧栏变乱 | 体验差 | 标题带书名；删除书时归档；后续做"教材伴读" workspace |
| 学习会话工具面过大 | 误操作/注入风险；审批弹窗不在自绘聊天里，回合可能挂起 | C3 加 preset/restrict 只留 `textbook_*`；首版提示"只用教材工具"并监控 tool/call |
| Agent 绕圈/工具轮数多 | 首 token 慢、费用高 | 上下文头 + 短工具结果 + 读预算；UI 显示活动；提示"先答再补" |
| 会话被删/迁移失败 | 聊天打不开 | 检测后重建；`chat.json` 自愈；保留旧笔记 |
| 双入口（聊天 vs DSH 对话）混乱 | 用户不知道去哪 | 同一会话；"在对话中打开"；聊天面板明确"本书专属" |
| 三栏太挤 | PDF 看不清 | 聊天打开时折叠阅读器左栏；窄屏抽屉；可拖拽 |
| SSE 断流/重复 | 消息错乱 | 事件带 seq；前端去重；重连带 afterSeq；断流不落半成品 |
| 模型不可用 | 聊天空白 | 启动检查 + 明确设置引导；禁用输入 |
| DSH Agent API 变化 | 升级坏 | ChatBridge 只依赖 `agents.create/resume` + `Agent.followup/cancel` + `sessions.get` + `agent/assistant-stream` 最小面；契约测试 |

---

## 13. 需要你拍板

1. **聊天范围**：每本书一个专属会话（推荐）还是复用当前 DSH 会话？
   - 前者：书与聊天一一对应、记忆干净、可实现双栏；代价是侧栏多会话。
   - 后者：不新增会话，但主面板拿不到当前会话 id，且学习会混进工作会话；更适合后续右侧栏方案。
2. **聊天位置**：阅读器主面板内双栏（推荐先做）还是 DSH 原生右侧栏 tab？
   - 前者：可控、可交付；后者：更原生，但"打开指定 tab"的控制器未公开，需额外 spike。
3. **工具面**：教材会话是否只允许 `textbook_*`（推荐）还是全工具？
   - 前者更安全、更像"导师"；后者更灵活但可能跑偏/有文件操作风险。
4. **是否保留"卡片式"导读/笔记**：推荐保留为聊天里的快捷 prompt + Artifact，不再做独立卡片主界面。

> 建议：**1 选每本书一个会话，2 选主面板双栏，3 选只允许教材工具**。后续先做 C0（3 天 spike），通过再做 C1；不通过就按 12 的备选方案调整。
