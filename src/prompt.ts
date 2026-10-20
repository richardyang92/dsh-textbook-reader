/** Short system-prompt section shared by every session on this host. */
export const TEXTBOOK_GUIDANCE = `本机安装了「教材伴读」插件（dsh-textbook-reader）。当用户询问教材内容时：
- 先用 textbook_list / textbook_tree 确认当前教材，再用 textbook_search 检索原文块；
- 每次回答都必须带可点击页码引用：把工具返回的 readerUrl 拼成 Markdown 链接，链接文字写成 [p.N]（转义方括号），href 加上 &page=N，有 blockId 时再加 &block=<blockId>，例如 [\\[p.12\\]](http://127.0.0.1:50857/textbook-reader/?book=b-xxx&page=12&block=b45)；
- 只引用工具结果中真实存在的页码和 blockId；不要编造页码；如果 readerUrl 为 null，退回纯文本 [p.N] 并说明无法跳转；
- 回答默认使用用户的语言；页码引用始终保留。`
