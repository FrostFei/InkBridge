# InkBridge · 墨桥

适配 iPad 的离线优先 Markdown PWA，通过 GitHub Git Database API 与电脑 Obsidian 笔记库同步。纯静态前端；笔记在浏览器 IndexedDB 中，Token 只在当前页面内存中。

## 本地运行

使用 Node.js 24 LTS 和 npm。项目初始目录只有 `DEVELOPMENT_SPEC.md`，本实现从零创建。

```powershell
npm ci
npm run dev
```

打开终端显示的本地地址。无需 Token 即可编辑本地笔记本。连接 GitHub 时在应用内输入 Token，选择已有分支；刷新后重新输入，离线编辑无需凭据。

PWA 离线行为须使用生产构建验证，开发服务器用于代码开发：

```powershell
npm run build
npm run preview
```

## 验证

```powershell
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

`npm run check` 串行运行全部检查，需先安装浏览器。自动测试使用本地模拟 GitHub 和独立浏览器数据，不会访问真实笔记库。具体结果见 [验收记录](docs/VALIDATION.md)。

Windows 若没有 Playwright Chromium、但已安装标准路径的 Chrome，测试配置自动使用它。也可通过 `PLAYWRIGHT_CHANNEL=chrome` 显式选择。此次浏览器下载受网络重置影响，实际使用本机 Chrome 验证；不代表 Safari 真机通过。

## 操作方式

- 笔记路径可包含目录、中文和空格，保持大小写。编辑短防抖后写入 IndexedDB；显示“本地已保存”才代表持久化成功，上传状态另行显示。
- 初次连接必须下载完整支持范围的笔记，再建立同步基准。附件按需下载，或显式下载全部。中断后再次连接会重用已经缓存的 blob。
- 手动同步和恢复前台／网络时的尝试均使用同一个同步引擎。Token 不在内存时，请先重新授权。网页关闭后不持续同步。
- 冲突会阻止整个批次上传。查看共同基准、本地和远端后，选择版本、保留两份或手工合并，再同步。草稿和冲突保存在本地。
- 切换仓库或分支保留隔离的本地副本。未同步的笔记不会随切换删除。
- 导出 ZIP 包含当前本地 Markdown 和已下载附件，附带遗漏清单。不要把 ZIP 当作完整 Git 仓库备份。

## 交付文档

- [同步设计与恢复](docs/SYNC_DESIGN.md)
- [Token 与电脑 Obsidian 接入](docs/GITHUB_OBSIDIAN.md)
- [Cloudflare Pages 部署准备](docs/DEPLOYMENT.md)
- [验收记录与 iPad 真机清单](docs/VALIDATION.md)
- [阶段执行记录](IMPLEMENTATION_PLAN.md)

此轮仅做本地开发、构建和部署准备。未公开部署，未测试真实 GitHub 写入，未进行 iPad Safari 真机验收。
