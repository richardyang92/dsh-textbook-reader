# M3 验证：pdf.js 阅读器、章节树编辑与学习进度

状态：✅ 已完成（真实 400 页教材的视觉验收仍待 M2 token 校准后复跑）。

## 自动测试

```bash
pnpm test
```

M3 覆盖：

- 章节树 `rename` / `merge` / `relevel` 三种手动操作，含章/节合并、章降节、节升章后的父子关系与页码范围校验；
- 非法操作（合并第一章、空标题、找不到节点）返回 422/404；
- HTTP `POST /api/books/:id/tree` 落盘后 `GET` 可读回；
- reader HTML、`assets/app.js`、`assets/app.css`、`vendor/pdf.min.mjs`、worker 均可由宿主路由访问；
- 此前 M1/M2 的进度、树、解析、token、Range、信任栅栏测试继续通过。

浏览器交互自测（Chromium，脚本化）得到：

```json
{
  "pageAfterJump": "15",
  "pageAfterTree": "5",
  "highlightCount": 1,
  "pageAfterReload": "5",
  "mastery": "3",
  "questionFound": true,
  "chapterTitle": "第1章（手动改名）",
  "errors": []
}
```

## 手动验证

```bash
pnpm build
node scripts/seed-m2-demo.mjs --data test/.tmp/m3-demo --fresh
node scripts/dev-server.mjs --data test/.tmp/m3-demo --port 52010
```

打开 `http://127.0.0.1:52010/textbook-reader/`，进入示例教材：

1. 左侧出现 3 章 × 9 节章节树；
2. 点击任意节 → 右侧 pdf.js 滚到对应页，页码同步；
3. 在「学习进度」里修改「每章掌握度」/ 添加疑问（已读章节通过 `textbook_progress_update` 或 API 维护）；
4. 悬停章节行 →「改名 / 合并 / 降为节」，确认后刷新仍保留；
5. 刷新浏览器 → 当前页、已读、掌握度、疑问均在（来自 `progress.json`）；
6. 重启 fixture 服务器（同一 `--data` 目录）→ 数据仍在。

### 页码引用高亮

取某一页的块 ID：

```bash
curl -s http://127.0.0.1:52010/textbook-reader/api/books/<id>/pages/15
```

打开：

```text
http://127.0.0.1:52010/textbook-reader/?book=<id>&page=15&block=<blockId>
```

页面会滚到第 15 页，并在解析 bbox 位置显示高亮框。M4 会把聊天里的 `[p.N]` 链接接到同一入口。

证据截图：[m3-reader.png](screenshots/m3-reader.png) · [m3-highlight.png](screenshots/m3-highlight.png) · [m3-progress.png](screenshots/m3-progress.png)

## 已知限制

- 章节树合并/纠层通过 `confirm` 确认；不做拖拽排序；
- 重复解析会重建章节树（手动编辑不迁移），该策略在 M5 文档中明确；
- pdf.js 渲染 canvas；可拖选的文本层来自 MinerU 解析块（M4 起支持选区提问）；
- 跨进程重启的自动解析恢复标记为 `interrupted`，不自动续跑。
