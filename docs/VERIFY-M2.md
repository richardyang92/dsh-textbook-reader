# M2 验证：MinerU 解析管线与章节树

状态：✅ 代码与合成数据验证完成；⚠️ 真实 MinerU API 校准待 token。

## 自动测试

```bash
pnpm test
```

M2 覆盖：

- **zip 解压**：UUID 前缀 content_list、layout.json、full.md、images 自适应发现；非法/空 zip 明确报错；路径穿越工具函数；
- **MinerU client**：`POST /file-urls/batch` 请求体与 Bearer 头、`PUT` 上传不带 Content-Type、轮询解析 `extract_result`、token 失效映射为 `mineru_token_invalid`、zip 签名校验；
- **normalize**：content_list 的 `page_idx`/归一化 bbox/`text_level`；缺 content_list 时用 layout.json 的 PDF pt bbox + `page_size` 换算；表格 HTML 转文本；标题收集；
- **章节树**：420 页、8 章、32 节的合成教材生成合法三级树（书为隐式根）；平铺标题仍有导航；无标题时降级为按页分章并给出 warning；
- **解析 job**：假 MinerU 客户端跑通上传→轮询→下载→解压→normalize→建树；失败状态持久化且不静默；无 token 时零上传；重启把孤儿任务标记 interrupted；
- 解析产物写入 `parse/normalized.json`、`tree.json`；`GET /pages/:n`、`GET /tree`、`GET /asset/*` 可用。

## 手动 UI 验证（无需 token）

```bash
pnpm build
node scripts/seed-m2-demo.mjs --data test/.tmp/m2-demo --fresh
node scripts/dev-server.mjs --data test/.tmp/m2-demo --port 52000
```

打开 `http://127.0.0.1:52000/textbook-reader/`：

1. 书架显示「示例教材（30 页）」，解析状态「已解析」；
2. 进入书籍：左侧出现 3 章 × 3 节章节树；
3. 点击任意节 → PDF 跳到对应页、当前页输入框同步；
4. 刷新/重启 fixture 服务器 → 书籍、树、当前页仍在。

`seed-m2-demo.mjs` 使用假 MinerU 客户端与内存 zip，不发网络请求。截图：[m2-tree.png](screenshots/m2-tree.png)。

## 真实 MinerU 校准（待 token，尚未执行）

配置 token 后：

```bash
pnpm probe:mineru --pdf /path/to/one-page.pdf
```

输出仅包含脱敏状态、zip 条目名、JSON 顶层字段、content_list 首块字段/bbox 样例、layout 第一页字段。根据输出核对：

- `extract_result` 实际字段（file_name/state/full_zip_url/extract_progress）；
- zip 内部真实文件命名与目录层级；
- content_list bbox 坐标系是否确为 0..1000；
- layout.json 是否仍有 `page_size` 与 `pdf_info`。

校准后把实际形状写入 `test/fixtures.mjs` 或新的 fixture，保持自适应发现逻辑不变。

## 当前未完成

- 真实 ≥400 页教材（需要 token + 样书）；
- >200 页本地分段（M5 已完成，见 VERIFY-M5）；
- 章节树手动修正（M3）。
