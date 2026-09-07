# InkBridge · 墨桥

适配 iPad 的离线优先 Markdown PWA，通过 GitHub Git Database API 与电脑 Obsidian 笔记库同步。纯静态前端；笔记在浏览器 IndexedDB 中，Token 默认仅在页面内存中，可选择在此设备记住授权。

生产地址：[InkBridge 网页](https://frostfei.github.io/InkBridge/)。主分支通过 GitHub Actions 验证后发布至 GitHub Pages；应用源码与私人笔记库相互独立。

## 本地运行

使用 Node.js 24 LTS 和 npm。项目初始目录只有 `DEVELOPMENT_SPEC.md`，本实现从零创建。

```powershell
npm ci
npm run dev
```

打开终端显示的本地地址。无需 Token 即可编辑本地笔记本。连接 GitHub 时在应用内输入 Token，选择已有分支；勾选“在此设备记住授权”后，重新打开可继续同步。未勾选时刷新后重新输入，离线编辑无需凭据。

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

- 左栏“名称正序／名称倒序”仅改变各层笔记的名称排序，文件夹顺序与展开状态不变；搜索结果也按所选方向排序，刷新后保留偏好。
- 文件夹默认收起，可一键“全部展开／全部收起”；切换排序、搜索或最近修改列表不会重置当前展开状态，刷新后重新收起。
- “最近修改”提供当前笔记库在本机最近创建、编辑或重命名的 20 篇笔记，按修改时间倒序，显示完整路径以区分同名文件。记录离线保存在本机，同步不会清除；只阅读不会改变顺序，删除后自动移除。旧版本未记录的修改和 GitHub 下载时间不会被当作本机编辑时间。
- 拖动侧栏右边缘可调整宽度，支持鼠标和触控；双击恢复 280px，聚焦分隔线后用左右方向键微调、Home／End 调至边界。宽度范围为 240–600px，并随窗口缩窄限制上限；返回宽屏或刷新后恢复偏好。
- 正文默认 18px，可在“设置与本地数据 → 正文大小”选择 18／20／22px；编辑与阅读同步生效，横竖屏保持字号，刷新后保留选择。左上角导航按钮可收起侧栏，扩大阅读区域。
- 工具栏右侧“更多笔记操作”集中提供重命名、删除和导出 ZIP；“笔记信息”按需显示完整路径及统计。导出 ZIP 的范围仍为当前笔记库。
- 工具栏提供“编辑／分栏／阅读”，会记住所选模式。窄屏仅显示“编辑／阅读”；从分栏缩窄时跟随最近操作的一侧，恢复宽屏后回到分栏。切换保留当前笔记的光标、选区与两侧滚动位置。
- 视图按钮支持方向键、Home／End 移动焦点，Enter／空格选择；键盘选择“编辑”后可继续输入，触屏切换不会主动聚焦编辑器。已有 PWA 出现更新提示时，点击“保存并更新”加载新界面。
- 笔记路径可包含目录、中文和空格，保持大小写。编辑短防抖后写入 IndexedDB；显示“本地已保存”才代表持久化成功，上传状态另行显示。
- 初次连接必须下载完整支持范围的笔记，再建立同步基准。附件按需下载，或显式下载全部。中断后再次连接会重用已经缓存的 blob。
- 手动同步和恢复前台／网络时的尝试均使用同一个同步引擎。未记住授权或 Token 过期时，请重新授权。网页关闭后不持续同步。
- 右上角“同步”点击后立即显示进度，先保存当前输入再与 GitHub 同步，无需等待自动保存计时器；同步期间按钮禁用，避免重复提交。
- 连接面板和“设置与本地数据 → GitHub 授权”均可开启“在此设备记住授权”。记录按笔记库和分支隔离，保存在当前浏览器 IndexedDB 的独立凭据表中，不参与笔记同步或 ZIP 导出。取消勾选只保留本次会话；“清除授权”同时移除当前会话和本机记录，本地笔记不受影响。
- 冲突会阻止整个批次上传。查看共同基准、本地和远端后，选择版本、保留两份或手工合并，再同步。草稿和冲突保存在本地。
- 切换仓库或分支保留隔离的本地副本。未同步的笔记不会随切换删除。
- 导出 ZIP 包含当前本地 Markdown 和已下载附件，附带遗漏清单。不要把 ZIP 当作完整 Git 仓库备份。

## 交付文档

- [同步设计与恢复](docs/SYNC_DESIGN.md)
- [Token 与电脑 Obsidian 接入](docs/GITHUB_OBSIDIAN.md)
- [Cloudflare Pages 部署准备](docs/DEPLOYMENT.md)
- [验收记录与 iPad 真机清单](docs/VALIDATION.md)
- [阶段执行记录](IMPLEMENTATION_PLAN.md)

GitHub Pages 使用 `npm run build:pages` 构建到 `dist-pages`，根路径托管使用 `npm run build` 构建到 `dist`。子路径 PWA 与 CSP 由 `npm run test:pages` 验证。真实笔记库写入与 iPad Safari 真机仍需单独验收。
