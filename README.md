# jizuo-creator-memory

DeepSeek Harness 创作插件：小说记忆与知识图谱。

## 安装

已验证的宿主版本：**DeepSeek Harness 0.1.7-rc.1**，Node.js >=22.19、pnpm 11.7。其他 Harness 版本暂不声明兼容，请勿强制跳过版本检查。

```sh
dsh plugin --profile web add https://github.com/ShikangPang/jizuo-creator-writing/releases/download/v0.2.1/jizuo-plugin-0.2.1.tgz https://github.com/ShikangPang/jizuo-creator-memory/releases/download/v0.2.1/jizuo-memory-plugin-0.2.1.tgz
dsh --profile web
```

安装预构建包，不需要克隆私有仓库或在安装时编译插件。共享核心与所选插件一起安装；三个插件共用同一个核心。已有即作内置这些插件时，请勿重复安装。公开包不提供旧章节工作流及其原生 SQLite 扩展，普通写作、视频和记忆通过当前创作对话完成。不要在公开包配置中开启 chapterWorkflowEnabled。桌面即作原有工作流能力不受影响。

也可以克隆本仓库后执行 `node scripts/install.mjs --all` 一次安装三个插件；指定 `--profile <name>` 选择现有 Web profile。该脚本检查宿主版本，仅通过 Harness 官方插件命令安装到指定 profile，不绕过版本检查。

## 项目与来源

小说与视频有独立项目及目录设置。视频通过引用小说的作品 ID、章节和版本生成剧本，目标视频目录与源小说目录分离。旧混合作品不自动搬迁或删除。删除或修改源小说不会删除视频项目；来源不可用时需重新选择。模型由 Harness 配置，调用图片/视频模型可能由相应服务商计费。

## 开发与构建

```sh
pnpm build
pnpm pack
pnpm pack:core
node scripts/install.mjs --local
```

编辑 `src/`；`shared/` 附带必要共享源码、资源和公开 npm 锁文件。构建在 `.build/workspace` 内隔离进行，产生本插件和共享核心，完全不访问私有 Git 仓库。各仓库维护相同版本的共享源码快照，修改公共接口时需同步三个插件与核心版本。

浏览器使用 Harness RPC，桌面专用账号、更新与原生文件对话框不在 Web 中调用。导入/导出需使用当前界面实际支持的入口。关闭插件不会删除项目或取消既有后台任务。

卸载：`dsh plugin --profile web remove @jizuo/memory-plugin`。只有全部创作插件卸载后才可移除 `@jizuo/plugin`。

源码许可证：MIT。此仓库不包含桌面发布工具、私有仓库历史、用户作品、账号配置或会话。
