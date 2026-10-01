# jizuo-creator-memory

DeepSeek Harness 原生创作插件，包名保持 `@jizuo/memory-plugin`。包含 Host 工具与领域接口、Web Client 面板。

## 构建

需要 Git、Node.js >=22.19、pnpm 11.7.0，以及读取私有核心仓库的权限。无需先在此目录安装依赖。

```sh
pnpm build
pnpm pack
```

构建脚本下载 `core-source.json` 固定提交，在忽略的 `.build/core` 中安装锁定依赖、覆盖本仓库源码、执行类型检查和构建，产出 `lib/index.js` 与 `lib/client.js`。`pnpm typecheck` 仅检查类型。不会修改已有即作工作目录。

编辑 `src/`，构建配置位于 `build/`。公共 UI、契约及部分服务实现仍依赖固定版本的核心仓库；这属于独立版本管理的插件仓库，尚未完成全部源码依赖解耦。新增依赖或升级公共代码时需同步更新核心提交及锁文件。

本地构建可通过 `JIZUO_CORE_REPOSITORY=/绝对路径/jizuo-harness` 使用本地核心 Git 仓库；构建始终使用固定提交。离线缓存完整时可设置 `JIZUO_BUILD_OFFLINE=1`。

## 接入 Harness

安装构建后的 tarball，并使用 `cordis.patch.yml` 中的插件入口。必须先加载兼容版本的 `@jizuo/plugin` 核心，由其提供 `jizuoCreationHost` 和 `jizuoCreationClient`。仅安装通用 Harness 无法运行。保持原生模块名以兼容现有即作加载器；不要重复添加默认即作已经加载的插件。

浏览器面板依赖共享核心状态，不能复制为第二个状态实例。关闭 UI 不删除数据或停止已有后台任务。原有 RPC 兼容入口仍由核心管理。

仓库默认私有，未发布 npm，也不包含用户作品、账号配置或会话。
