# M4 验证：侧栏入口、主面板 iframe、agent 工具与 [p.N] 引用

状态：✅ 已完成。已在真实 DSH Web profile（`dsh --profile web --port 52100`）中完成端到端验证；桌面端安装路径见 README。

> 说明：以下端到端记录来自 M4 验收时的对话界面。0.6.0 起同一链路收敛为阅读器右侧的「AI 伴读」面板，最新截图见 [m4-chat-tools.png](screenshots/m4-chat-tools.png) 与 [m4-citation-jump.png](screenshots/m4-citation-jump.png)。

## 自动测试

```bash
pnpm test
```

M4 覆盖：

- 浏览器半 bundle 以 `window.__ModuleLoader__.load({ id: "dsh-textbook-reader", factory })` 注册，id 必须等于包名；
- 注册 `main`（key=`textbook-reader`）与 `sidebar.panellist`（id=`textbook-reader`）；
- capture 阶段拦截 `/textbook-reader/` 链接：`preventDefault` 并切到阅读器面板；
- 7 个 agent 工具注册名与执行：`textbook_add/list/parse/tree/search/progress/progress_update`；
- `textbook_search` 返回真实 `page/blockId/bbox` 与 `citationUrl`；
- `textbook_progress_update` 落盘 currentPage/已读/掌握度/疑问；
- 宿主 `apply()` 注册工具、系统提示段落与 `/textbook-reader` 路由；
- `GET /api/books/:id/search`。

## 真实 DSH 端到端证据

安装到开发 web profile：

```bash
pnpm build
dsh plugin --profile web add file:/absolute/path/to/dsh-textbook-reader
dsh --profile web --port 52100 --no-open
```

在浏览器打开带 token 的 URL 后：

1. 侧栏出现「教材伴读」图标（官方侧栏只多这一行）；
2. 点击后主面板出现独立 iframe 阅读器，默认官方对话/列表不被替换；
3. 在对话里要求 agent 调用 `textbook_list` + `textbook_search` 检索「正文」；
4. agent 实际调用了工具，并输出：

   ```text
   教材《示例教材（30 页）》共 30 页；下面的检索结果定位到 [p.1]，该页是正文首块，可点击查看。
   ```

   其中 `[p.1]` 是 Markdown 链接，href 为
   `http://127.0.0.1:52100/textbook-reader/?book=b-bb2eccd95adc&page=1&block=b3`；
5. 点击该链接：客户端 capture 拦截，切到「教材伴读」主面板，iframe 打开对应书，页码为 1，DOM 中 `.pdf-highlight` 数量为 1（bbox 高亮生效）。

实测读数：

```json
{
  "anchorText": "[p.1]",
  "href": "http://127.0.0.1:52100/textbook-reader/?book=b-bb2eccd95adc&page=1&block=b3",
  "afterClick": {
    "page": "1",
    "highlights": 1,
    "title": "示例教材（30 页）",
    "currentProgress": "当前第 1 页 · 已读 0 个章节 · 已评掌握度 0 章"
  }
}
```

证据截图：[m4-dsh-sidebar.png](screenshots/m4-dsh-sidebar.png) · [m4-chat-tools.png](screenshots/m4-chat-tools.png) · [m4-citation-jump.png](screenshots/m4-citation-jump.png) · [m4-selection.png](screenshots/m4-selection.png)

> 演示数据是假 MinerU 解析产物，仅用于 UI/工具/引用链路验证；验证后已从默认数据目录删除。真实 400 页教材验收仍待 MinerU token。

## 桌面端

CLI 无法管理 desktop profile。最终交付：

1. 桌面端 → 插件 → 添加插件 → 填本目录绝对路径；
2. 启用后重启桌面端；
3. 侧栏出现「教材伴读」即安装成功。

桌面端使用同一 host/client bundle；客户端与阅读器已在真实 web profile 验证，桌面端需用户执行上述安装（或由宿主 UI 安装）。
