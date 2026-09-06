# 部署准备

准备目标为 Cloudflare Pages，也可部署到支持 HTTPS 的静态主机。尚未建立云服务、连接 Cloudflare 账号或公开发布。

## Cloudflare Pages

1. 将应用源代码放在独立的代码仓库；不要把私有 Obsidian 笔记库作为应用仓库。提交依赖锁文件，不提交 `node_modules`、`.env`、Token、测试笔记或导出 ZIP。
2. 在干净环境执行 `npm ci` 和 `npm run check`。安装测试浏览器的命令为 `npx playwright install chromium`，Linux CI 使用 `npx playwright install --with-deps chromium`。
3. 在 Cloudflare 控制台 Workers & Pages 中创建 Pages 项目，连接这个应用代码仓库。构建命令 `npm run build`，输出目录 `dist`，根目录为仓库根目录，Node 版本设置为 `24`（如平台提供更细版本，请与本地已验证版本一致）。不需要 Functions、数据库或任何 GitHub Token 构建环境变量。
4. 发布前审查 `dist`：只应含应用资源。`public/_headers` 与 `_redirects` 会复制到输出目录。授权公开部署后，才在控制台执行发布。
5. 在最终 HTTPS 地址检查 manifest、图标、`sw.js`、CSP 和重载路由。等待“应用可离线打开”后断网测试。先用专门的测试笔记仓库完成真实联调，再连接实际笔记库。

构建与 `dist` 设置已核对 [Cloudflare 官方 Vite 部署文档](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/)。使用 Git 集成后，推送可能触发自动发布；请按自己的发布流程设置生产分支。

截至 2026-09-06 查阅的 [Pages 限额文档](https://developers.cloudflare.com/pages/platform/limits/)：Free 为每月 500 次构建、同时 1 次构建；每站点 20,000 文件、单个静态资源最大 25 MiB。额度会变化，实际发布前再次核对账号计划和官方页面，不将本记录视为永久免费承诺。笔记及附件存在浏览器和 GitHub，**不是** Pages 构建资源；GitHub API 与浏览器存储另有限制。

## 安全配置

- CSP 仅允许本地脚本和到 `api.github.com` 的连接；没有第三方统计或字体。CodeMirror 需要内联样式，因此仅 `style-src` 允许 `unsafe-inline`，脚本仍不允许。
- 外部图片由用户显式开启；开启后图片主机会看到请求，因此默认关闭。私有附件通过授权 API 下载并使用 Blob URL。
- 禁止 iframe、插件对象、表单提交及其他站点嵌入本应用。笔记 HTML 在显示前清洗，危险 URL 被丢弃。
- Service Worker 仅预缓存构建资源；不建立 GitHub API 通用缓存。笔记缓存明确写入 IndexedDB，Token 不写入其中。
- Service Worker 更新提示采用 [Vite PWA 的手动刷新流程](https://vite-pwa-org.netlify.app/guide/prompt-for-update)。不要在未保存时强制刷新，也不要让其他标签页的更新打断正在输入的页面。
- 本地 Vite preview 不自动解释 Cloudflare `_headers`；生产站点必须实际检查响应头。部署到其他主机时转换并应用同等响应头。

## 回滚与数据

Pages 可回滚应用发布，但这不会回滚浏览器 IndexedDB 或笔记仓库。后续数据结构升级应使用向前兼容的迁移，并在升级前导出本地笔记。不要以清除网站数据作为常规升级步骤。

更换域名、HTTP/HTTPS 或端口会改变浏览器存储来源；旧来源笔记不会自动迁移到新来源。先在旧地址同步并导出，再迁移；保留旧地址直到核对完毕。
