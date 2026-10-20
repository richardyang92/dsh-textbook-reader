# M5 验证：分段、失败降级、外发审计与最终验收

状态：✅ 代码与合成/实测 UI 证据完成；⚠️ 真实 MinerU API 与真实 ≥400 页教材仍待 token。

## 自动测试

```bash
pnpm test
```

当前 **41 项**通过。最新 M5 构建已在真实 DSH Web profile（端口 52102）重新安装并确认 host/client 均激活、iframe 正常加载（截图：[m5-dsh-latest.png](screenshots/m5-dsh-latest.png)）。

M5 新增覆盖：

- **>600 页分段**：`splitPdf` 把 23 页切成 10/10/3，三段分别解析后合并回 1..23 页；标题页码加偏移；重复封面标题去重；分段临时 PDF 清理；分段图片仍可访问；测试用 `maxPagesPerTask=10` 模拟 MinerU 600 页上限。
- **失败降级**：网络不可达 → `mineru_unreachable`；超时 → `mineru_timeout`；MinerU 页数拒绝 → `mineru_page_limit`；损坏 zip → 解析状态 `failed` + `zip_invalid`，不会静默成功。
- **URL 安全**：拒绝 http、localhost、私网地址的结果包/上传 URL（防 SSRF）。
- **无 token**：返回 `token_missing`，不发起上传。
- **外发审计**：在真实 parse 流程中注入 fetch 计数器；图注 VLM 默认关闭时，请求 host 仅 `mineru.net` / 上传 OSS / 结果 CDN，零 caption/embedding/image-generation 请求。

## 420 页教材证据（合成 MinerU 产物）

```bash
node scripts/seed-m2-demo.mjs --data test/.tmp/m5-large --pages 420 --chapters 8 --sections 4 --fresh
node scripts/dev-server.mjs --data test/.tmp/m5-large --port 52020
```

- 8 章 × 32 节三级树；
- 点树节点跳到第 125 页；
- 关闭/重启 fixture 服务器后：

```text
progress after restart: currentPage=125
tree after restart: 8 chapters, 32 sections
```

截图：[m5-420-pages.png](screenshots/m5-420-pages.png)

> 这是合成的 420 页 PDF + 假 MinerU 产物，用于验证分页/树/进度；**不是**真实 MinerU 云解析。

## 无 token 降级证据

```bash
node scripts/dev-server.mjs --data test/.tmp/no-token-demo --port 52021 --fresh
```

打开书籍 →「开始解析」，界面显示：

```text
尚未配置 MinerU token。
打开「教材伴读」→ 设置，填入 mineru.net 的 API token（只保存到本机 0600 文件）。
```

不产生任何网络请求，书籍仍可正常翻阅。截图：[m5-no-token.png](screenshots/m5-no-token.png)

## 真实 API 待办

拿到 token 后执行：

```bash
pnpm probe:mineru --pdf /path/to/one-page.pdf
```

确认：

- `extract_result` 实际字段；
- zip 内真实命名/目录；
- content_list bbox 坐标系；
- layout.json 是否保留 page_size/pdf_info。

随后用 ≥400 页真实教材跑一次 `textbook_parse` + 章节树 + `textbook_search` + `[p.N]` 点击，补齐验收 #1 的“真实 MinerU”部分。
