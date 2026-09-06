# GitHub 连接与电脑端接入

## 凭据

在 GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens 创建 Token，选择笔记仓库的资源所有者，仅选定所需的测试／笔记仓库。Repository permissions 中 `Contents` 设为 Read and write；`Metadata` 为 GitHub 必需的只读权限。不要授予 Administration、Actions 或 Workflows 等无关权限。设置适当到期时间；组织仓库可能需要组织审批。

在 InkBridge 连接面板输入所有者、仓库名和 Token，读取已有分支后选择。这里的仓库名不是 URL，也不要将 Token 放到 URL 中。Token 仅保存在当前页面内存；刷新后重新输入。请勿把 Token 发到聊天、写进源码、前端环境变量、笔记、日志或导出文件。操作依据 [GitHub Token 官方说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) 与 [Git Database API](https://docs.github.com/en/rest/git)。

连接时可以验证仓库和分支可读以及可见的仓库权限；没有实际写入就无法完整证明 Token 的 Contents 写权限与所有分支规则允许提交。第一次真实写入仅在授权的测试仓库进行。分支保护、强制签名和组织策略可能拒绝提交；应用保留本地更改，不禁用保护、不强制推送。

## 电脑 Obsidian

1. 先备份现有库。在电脑安装 [Git](https://git-scm.com/downloads)，配置自己的用户名、邮箱和 GitHub 凭据管理器。
2. 创建或克隆自己的私有笔记仓库。在 Obsidian 中以该目录作为 vault。不要把 InkBridge 应用代码混入 vault。
3. 可安装社区插件 Obsidian Git，并按 [插件官方文档](https://publish.obsidian.md/git-doc/) 配置桌面 Git；也可以直接使用其他 Git 客户端。
4. 在电脑修改前拉取，切换到 iPad 前提交并推送。iPad 开始编辑前同步，切回电脑前再次同步。双方同时修改时，InkBridge 会三方合并或要求处理冲突。
5. `.obsidian/` 中设备专属工作区文件是否通过电脑端 Git 同步，由用户自行决定；InkBridge 默认不编辑这些文件。它创建新 tree 时保留远端未支持项。

不要在此流程中对已有笔记库执行 `git reset --hard`、强制推送或删除目录。InkBridge 是独立浏览器本地副本，不会读写 iPad Obsidian 的沙盒目录。

## 错误与处理

| 提示                   | 处理                                                         |
| ---------------------- | ------------------------------------------------------------ |
| Token 无效或到期       | 在应用重新输入新 Token；离线内容保留                         |
| 权限不足／组织审批     | 检查选定仓库、Contents 权限和组织审批                        |
| 仓库不存在             | 确认所有者与仓库名；私有库权限不足也可能表现为 404           |
| API 限流               | 等待重试时间；不连续点击同步                                 |
| 分支保护／签名限制     | 使用符合自己仓库规则的已有测试分支；不要自动关闭保护         |
| 网络错误或提交结果不明 | 恢复网络并重试；引擎先核实已准备提交是否被接受               |
| 基准或历史需要恢复     | 先导出本地副本；按应用中的显式恢复流程重新对照，保留人工草稿 |
