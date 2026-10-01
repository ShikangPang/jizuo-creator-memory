# jizuo-creator-memory

即作记忆：创作记忆、设定与知识图谱查询。

## 在 Desktop 的插件页面安装

支持 **DeepSeek Harness Desktop 0.2.0-rc.2**。在左侧「插件」→「添加插件」粘贴下面这一行，确认来源后安装：

```text
https://github.com/ShikangPang/jizuo-creator-memory/releases/download/v0.3.12/jizuo-memory-plugin-0.3.12.tgz
```

只填安装包地址，不要填整个安装命令。安装完成后「已安装」中显示「即作记忆」，可分别启用、关闭、配置或卸载。共享核心已包含在安装包中，自动加载，不需要另装即作桌面端或手动安装核心插件。保留 Harness 原有新会话、插件与工作区入口；创作项目统一显示在工作区区域，小说和视频以类型标签区分，不再提供独立的创作面板。

关闭插件不会删除项目。卸载任一创作插件后，请重启 Harness，以刷新共享组件路径；单纯启停不需要重启。关闭一个插件不会关闭其他仍启用的创作插件。五个插件分别安装、启停。媒体模型提供图片/视频服务配置和聊天生成工具，不要求安装视频项目插件；即作账号提供浏览器登录和账号模型。停用账号保留凭据，退出账号才清理即作凭据；第三方媒体密钥不受影响。

也可使用 Desktop 菜单安装的 dsh 命令：

```sh
dsh plugin --profile desktop add https://github.com/ShikangPang/jizuo-creator-memory/releases/download/v0.3.12/jizuo-memory-plugin-0.3.12.tgz
```

源码克隆后运行 `node scripts/install.mjs --all` 一次安装五个插件，默认 desktop；Web 用户显式传 `--profile web`。脚本严格检查宿主版本。不要用旧版全局 dsh 命令安装到新版 Desktop，也不要绕过兼容检查。

## 项目与数据

小说与视频统一显示在工作区列表，创建时选择类型，使用独立项目及目录。已有项目按真实目录关联 Harness 工作区，不自动创建空会话。视频通过作品 ID、章节和版本引用小说；视频项目的编辑和删除不会删除源小说。旧混合作品保留兼容读取，不自动迁移或删除。模型由 Harness 配置，图片/视频模型调用可能由服务商计费。

公开包不提供旧章节工作流及其原生 SQLite 扩展；请使用普通创作对话，不要开启 chapterWorkflowEnabled。

## 开发

```sh
pnpm build
pnpm pack
pnpm pack:core
```

Node.js >=22.19。编辑 src/；shared/ 包含必要共享源码、资源和公开依赖锁文件。构建在 .build/workspace 隔离进行，不访问私有仓库。五个仓库的共享源码与核心版本应同步维护。安装发布包无需本地构建。

卸载：`dsh plugin --profile desktop remove @jizuo/memory-plugin`。插件不自动升级，更新请使用新版安装地址。GitHub 的 dsh-plugin 标签用于发现插件，并不代表官方认证。

MIT 许可证。此仓库不包含用户作品、账号配置、会话或私有仓库历史。
