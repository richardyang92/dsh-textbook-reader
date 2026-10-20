# M1 验证：宿主存储、token、PDF 导入与阅读器壳

状态：✅ 已完成（桌面端插件安装验收顺延到 M4 侧栏入口出现后）。

## 自动测试

```bash
pnpm install
pnpm test
```

覆盖：

- token 写入 `0600`、API 只回 `••••1234` 掩码、响应体不含明文；token 太短/冲突命令明确报错；
- PDF 路径导入、原始上传、重复检测、确认删除、200MB 限制；
- PDF Range 206/416、HEAD、Content-Range；
- Host/Origin/Sec-Fetch-Site 信任栅栏；
- 静态路径穿越拒绝；
- 进度写入/读取、非法页码、跨 Store 实例持久化；
- `apply()` 注册 `/textbook-reader` prefix 路由并在 fiber 释放时注销。

## 手动 UI 验证

```bash
pnpm build
node scripts/dev-server.mjs --data test/.tmp/m1-dev --port 51999 --fresh
```

打开 `http://127.0.0.1:51999/textbook-reader/`：

1. 书架出现「示例教材（5 页）」；
2. 点击卡片 → 浏览 PDF；
3. 把当前页改为 4 →「保存页码」；
4. Ctrl+C 停止服务器，再去掉 `--fresh` 重启：

   ```bash
   node scripts/dev-server.mjs --data test/.tmp/m1-dev --port 51999
   ```

5. 刷新页面 → 当前页仍为 4（持久化生效）；
6. 展开「MinerU 设置」，保存一个 token → 状态显示掩码；检查 `test/.tmp/m1-dev/mineru-token` 权限为 `600`。

证据截图：[m1-library.png](screenshots/m1-library.png) · [m1-reader.png](screenshots/m1-reader.png)

## 数据安全

- 数据目录 `0700`，token 文件 `0600`；
- API 响应中没有 token 明文；
- 错误消息不含绝对路径或 Authorization；
- 未配置 token 时解析入口返回 `token_missing`，不是静默失败。
