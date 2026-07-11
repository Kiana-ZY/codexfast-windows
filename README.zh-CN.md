# codexfast-windows

[English README](./README.md)
[Windows 说明](./README.windows.md)

> 本项目是基于 [`Veath/codexfast`](https://github.com/Veath/codexfast) `v0.49.1` 的独立公开适配，Windows 版本由 [`Kiana-ZY`](https://github.com/Kiana-ZY) 维护。本项目不是 OpenAI 官方项目。来源与授权见 [`UPSTREAM.md`](./UPSTREAM.md)。

**一个面向 OpenAI Codex Desktop 的 runtime launcher：支持已验证的 macOS build 和已完成只读签名检查的 Windows build，在当前会话应用补丁且不修改已安装 app bundle 或 MSIX。**

`codexfast` 会启动一个带 runtime patch 的 Codex 会话。它不会修改原始 `app.asar`、`Info.plist`、app bundle 或 app 签名。

- Settings 里的 **Fast** 控制项
- 输入框里的 **`/fast`** slash command
- composer 里的 **Speed** 菜单
- 面向 custom API 用户的 **GPT-5.5 / GPT-5.6 模型目录**元数据，最新支持版本包含 Sol、Terra 和 Luna
- macOS profile 中 Settings > General 里的 **Disable automatic updates** 开关

```text
git clone https://github.com/Kiana-ZY/codexfast-windows.git
cd codexfast-windows
corepack pnpm install --frozen-lockfile
corepack pnpm build
node ./bin/codexfast launch
```

这个独立仓库不是 npm 上名为 `codexfast` 的包；`npx codexfast` 会安装上游包。当前请使用 clone 后的本地命令，除非以后为本项目单独评审并启用新的 npm 包名。

平台补丁范围有意保持独立：macOS 保留上游现有 Fast、Speed、Plugins、updater 和模型补丁；Windows 启用 GPT-5.6 Sol/Terra/Luna，以及 Settings Fast、`/fast`、Intelligence Speed、allowance、request propagation 和 conversation fallback 组成的完整 Fast 功能。Windows 安装、MSIX/AUMID、覆盖项、fail-closed 行为、手动验证和回滚见 [`README.windows.md`](./README.windows.md)。

已验证支持 `ChatGPT.app` / `Codex.app` `26.707.31428`（`build 5059`）、`26.623.141536`（`build 4753`）、`26.623.101652`（`build 4674`）、`26.623.81905`（`build 4598`）、`26.623.70822`（`build 4559`）、`26.623.61825`（`build 4548`）、`26.623.42026`（`build 4514`）、`26.623.31921`（`build 4452`）、`26.623.31443`（`build 4441`）、`26.616.81150`（`build 4306`）、`26.616.71553`（`build 4265`）、`26.616.51431`（`build 4212`）、`26.616.31447`（`build 4133`）、`26.611.62324`（`build 4028`）、`26.611.61753`（`build 4008`）、`26.611.61049`（`build 3996`）、`26.609.71450`（`build 3965`）、`26.609.41114`（`build 3888`）、`26.609.30741`（`build 3808`）、`26.608.12217`（`build 3722`）、`26.602.71036`（`build 3685`）、`26.602.40724`（`build 3593`）、`26.602.30954`（`build 3575`）、`26.601.21317`（`build 3511`）、`26.527.60818`（`build 3437`）、`26.527.31326`（`build 3390`）、`26.519.81530`（`build 3178`）、`26.519.41501`（`build 3044`）、`26.519.31651`（`build 3017`）、`26.519.22136`（`build 3003`）、`26.513.31313`（`build 2867`）、`26.513.20950`（`build 2816`）、`26.506.31421`（`build 2620`）、`26.506.21252`（`build 2575`）、`26.429.61741`（`build 2429`）、`26.429.30905`（`build 2345`）、`26.429.20946`（`build 2312`）、`26.422.71525`（`build 2210`）、`26.422.62136`（`builds 2180, 2176`）、`26.422.30944`（`build 2080`）、`26.422.21637`（`build 2056`）、`26.417.41555`（`build 1858`）和 `26.415.40636`（`build 1799`）。功能范围见 [`docs/feature-scope.md`](./docs/feature-scope.md)。

Windows 模型与 Fast profile 已对 `OpenAI.Codex` MSIX `26.707.3748.0` 完成 8 个 runtime target pattern 的只读静态检查。更新后、尚未列入版本记录但已完成当前用户注册的 Windows 包，只有在注册身份与包身份一致、8 个允许目标在整个 `app.asar` 中各自唯一且替换可复核时，才会进入更窄的 `unlisted-signature-compatible` classification；这不等于真实应用支持声明。自动验证有意不激活或终止已安装的 Codex，真实 launch、UI、Fast 请求和 Provider 路由验证应在独立的手工会话中完成。

## 工作方式

`Codex.app` 的前端 bundle 里已经包含 Fast、`/fast`、Speed 和 updater 相关 UI 路径。`codexfast` 只 patch 已验证 build 上仍然需要的本地 gate。它不新增后端服务，也不调用 OpenAI 私有 API。

`codexfast launch` 会用本地 Chrome DevTools Protocol endpoint 启动 Codex，通过 browser-level CDP target 在 renderer JavaScript 执行前挂载拦截，拦截当前会话里匹配的 renderer JavaScript 响应，并在内存里应用窄范围 patch。Windows 通过 `IApplicationActivationManager` 激活 MSIX，不请求 UAC。使用 Codex 时需要保持 `codexfast launch` 进程运行。

Windows 中 Fast 对应 `service_tier: "priority"`，不会改变所选模型 id 或 Provider 路由。若 Provider 已配置为 `http://127.0.0.1:8317/v1`，实际请求仍由该 Provider 接收并决定是否支持所选模型与 Fast tier。

在 macOS profile 中，Settings > General 的 `Disable automatic updates` 开关会写入 Codex desktop 配置 `[desktop].disableAutomaticUpdates`，并通过当前进程 hook 跳过后续 Sparkle 后台检查和自动强制安装调度。Windows 不启用 Sparkle 或 updater 补丁。

launcher 会发送轻量 browser-level CDP heartbeat。runtime patch session 断开时最多做三次 bounded reconnect，仍失败则打印 `Runtime patch session lost`，并关闭本次启动的 Codex 进程、以非 0 退出，避免未受 runtime patch 保护的会话继续运行。如果 launch 进程本身被外部杀掉，需要完全退出 Codex 并重新用 `codexfast` 启动后，再依赖后续懒加载功能的 patch。

如果旧版 codexfast 安装过 launchd auto-repair watcher，`launch` 会在启动 Codex 前自动移除这个 legacy watcher。

## 使用

需要 Node.js `>=18.12.0`。macOS 需要 `/Applications/Codex.app` 或 `/Applications/ChatGPT.app`；Windows 需要当前用户注册的 `OpenAI.Codex` 或 `OpenAI.CodexBeta` MSIX，详见 [`README.windows.md`](./README.windows.md)。

首次从 GitHub clone、安装并构建，然后从仓库运行：

```text
git clone https://github.com/Kiana-ZY/codexfast-windows.git
cd codexfast-windows
corepack pnpm install --frozen-lockfile
corepack pnpm build
node ./bin/codexfast launch
```

检查 Windows 兼容性、查看帮助或版本：

```text
node ./bin/codexfast inspect
node ./bin/codexfast inspect --json
node ./bin/codexfast help
node ./bin/codexfast version
```

交互菜单只保留 launch：

```text
1) Launch Codex with runtime patches
q) Quit
```

### 命令

| Command | 说明 |
| --- | --- |
| `node ./bin/codexfast launch` | 启动当前前台 Codex runtime patch 会话。使用 Codex 时保持该命令运行。 |
| `node ./bin/codexfast inspect` | 不启动 Codex，只读检查 Windows MSIX 身份和 8 个必需 runtime targets。 |
| `node ./bin/codexfast inspect --json` | 以单个、带 schema 版本的 JSON 文档输出同一份 Windows 静态审计，供自动化使用。 |
| `node ./bin/codexfast help` | 显示帮助。 |
| `node ./bin/codexfast version` | 显示 codexfast 版本。 |

## 兼容性

脚本匹配的是 Codex 前端构建产物里的代码签名，所以 Codex 更新后可能失效。

- macOS `launch` 只允许在白名单里的 version/build 上执行
- Windows 每次运行都会重新核验当前用户 MSIX 注册、manifest、`AppxSignature.p7x` 文件快照和 8 个精确 ASAR target pattern；未列入版本记录但已注册的版本只能以 `unlisted-signature-compatible` classification 继续，不使用版本通配或长期信任缓存
- Windows 还要求从预期 renderer origin、资源路径和已检查 body hash 观察全部 6 个 Fast 目标与 2 个模型目标，否则 fail closed
- Runtime launch 不会改写 `app.asar`、`Info.plist`、app bundle、备份、app 签名或 macOS 隐私权限
- 仅 macOS profile 提供自动更新开关；Windows 不启用 updater 补丁

## 排查

**脚本立即失败** - 检查 `/Applications/Codex.app` 或 `/Applications/ChatGPT.app` 是否存在，以及 `node -v` 是否为 `18.12.0` 或更高。

**Runtime launch 显示 `Codex failed to start` / `ERR_FAILED`** - 完全退出 Codex，重新构建当前 clone，然后运行 `node ./bin/codexfast launch`。失败的 runtime launch 不应该修改 `app.asar`、`Info.plist`、app bundle、备份、app 签名或 macOS 隐私权限。

**`launch` 后 Settings Fast 或被 patch 的功能仍然缺失** - 确认 `codexfast launch` 终端进程仍在运行。关闭它会结束 CDP interception，后续懒加载的 chunk 就无法继续被 patch。

**macOS 修改开关后仍出现一次自动更新检查** - updater 可能在打开 Settings 页面前已经触发一次启动/后台检查，已经开始的检查无法撤回。打开开关后，同一次 `codexfast launch` 会话里的后续后台检查和自动强制安装调度会被跳过。

**出现 `Runtime patch session lost after reconnect attempts`** - codexfast 会关闭本次启动的 Codex，因为 runtime patching 已经不再活跃。完全退出任何残留的 Codex 进程，然后重新运行 `node ./bin/codexfast launch` 启动新的 patched session。

**以前安装过 auto-repair watcher** - 从仓库执行一次 `node ./bin/codexfast launch`。launcher 会在启动 Codex 前移除 `~/Library/LaunchAgents/com.codexfast.watcher.plist` 和旧的本地 watcher runtime。

## License

MIT。上游 `Copyright (c) 2026 Veath` 声明完整保留在 [`LICENSE`](./LICENSE)，仓库来源见 [`UPSTREAM.md`](./UPSTREAM.md)。
