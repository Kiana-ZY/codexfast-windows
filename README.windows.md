# codexfast for Windows

本文件说明 Windows 10/11 x64 上的 MSIX runtime launcher。Windows 实现默认使用普通用户权限，不请求 UAC，也不会修改已安装的 Codex 包。

需要按场景操作时，可直接双击打开 [`docs/codexfast-windows-best-practices.html`](./docs/codexfast-windows-best-practices.html)。该离线指南提供首次配置、日常启动、更新后检查、退出回滚、命令复制和可持久化检查清单。

当前已检查的基线：

- Package: `OpenAI.Codex`
- MSIX version: `26.707.3748.0`
- Package Family Name: `OpenAI.Codex_2p2nqsd0c76g0`
- Application Id: `App`
- AUMID: `OpenAI.Codex_2p2nqsd0c76g0!App`
- Executable: `app\ChatGPT.exe`
- Frontend archive: `app\resources\app.asar`

`26.707.3748.0` 是已记录的 Windows 基线。更新后、尚未列入版本记录的版本不会仅因版本号不同而自动失败：只有当前用户注册的官方 `OpenAI.Codex` / `OpenAI.CodexBeta` 包、manifest/PFN/AUMID/executable 身份完全一致，并且下列 8 个 runtime target pattern 在整个 `app.asar` 中各自唯一、替换后可复核时，才会得到 `unlisted-signature-compatible` classification。这个状态只表示静态 target 兼容，不等于已经完成真实 UI 和请求验证。

Windows profile 只启用以下 runtime targets：

- `Speed setting`
- `Speed service tier allowance`
- `Speed service tier request allowance`
- `Speed service tier conversation fallback`
- `Composer Intelligence Speed menu`
- `Fast slash command`
- `GPT-5.x model list`
- `GPT-5.6 model query selector`

模型下拉菜单目标为：

- GPT-5.6 Sol: Low / Medium / High / XHigh / Max / Ultra
- GPT-5.6 Terra: Low / Medium / High / XHigh / Max / Ultra
- GPT-5.6 Luna: Low / Medium / High / XHigh / Max

Windows 不启用 Sparkle、launchd、PlistBuddy、macOS updater、Plugins 或其他 macOS 专用补丁。

Fast 是一组完整功能，而不是只显示一个 UI 开关：Settings Fast、`/fast`、Intelligence 的 Speed 菜单、custom Provider allowance、request service tier 传递，以及 stop/edit/resend 和已有会话的 fallback 必须同时生效。UI 中 `Fast` 对应请求 service tier `priority`，不是另一个模型 id。

## 安装与构建

安装 Node.js `>=18.12.0`。Node.js 自带的 Corepack 可以在普通用户权限下按仓库锁定版本运行 pnpm，无需全局安装或管理员权限：

```powershell
git clone https://github.com/Kiana-ZY/codexfast-windows.git
Set-Location .\codexfast-windows
corepack pnpm install
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test:windows
```

如果本机 Node.js 未提供可用的 Corepack，可使用一次性、普通权限的 `npx --yes pnpm@10.33.0 <command>`，例如 `npx --yes pnpm@10.33.0 install`。

构建产物是 `bin\codexfast`。从源码目录运行：

```powershell
node .\bin\codexfast version
node .\bin\codexfast inspect
node .\bin\codexfast inspect --json
node .\bin\codexfast launch
```

本独立仓库当前不发布 npm 包。`npx codexfast` 和 `npm install --global codexfast` 会获取上游同名包，不是这里的 Windows 实现；请从 clone 目录使用 `node .\bin\codexfast ...`。

npm/pnpm 从本地目录或未来的独立包安装时，会根据 `package.json` 的标准 `bin` 字段生成 `codexfast.cmd`；仓库提供 `pnpm check:windows-shim` 做实际安装检查。

## 托盘快捷方式

源码仓库提供普通用户权限的 Windows 托盘启动器。安装或刷新桌面快捷方式：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows-shortcut.ps1
```

桌面 `CodexFast` 快捷方式会隐藏 PowerShell 窗口，并在 Windows 通知区域显示托盘图标。托盘菜单提供：

- 当前 `Starting` / `Active` / `Stopped` / `Failed` 状态
- 启动或失败后重试 CodexFast
- 查看 launcher 日志
- 打开项目目录
- 在 launcher 已停止时退出托盘

同一项目目录的托盘已经运行时，再次双击快捷方式会向现有托盘发送一次启动请求，不会创建第二个 launcher。不同 clone/项目目录使用各自的 IPC 标识，不会把新目录的启动请求误发给旧目录。

日志保存在项目目录：

```text
logs\launcher.log
logs\launcher.previous.log
```

`launcher.log` 达到 5 MB 后会在下次启动前轮转。托盘仍然需要一个隐藏的 PowerShell/Node 后台进程维持 CDP patch session，但不需要保持可见终端窗口。补丁会话活跃时，`Exit tray` 不会强杀 launcher；应先正常退出 Codex Desktop，等待状态变为 `Stopped`，再退出托盘。

日志只写入当前项目目录下的 `logs`，不会写入 `%LOCALAPPDATA%\codexfast`。快捷方式的 `ExecutionPolicy Bypass` 只应用于该隐藏 PowerShell 进程，不修改用户或系统的持久执行策略。安装器会把当时解析到的 `node.exe` 绝对路径写入快捷方式；仓库移动、Node.js 被升级到其他路径，或使用 nvm/fnm 切换并删除旧 Node 后，应从当前项目目录重新运行安装命令。

## 启动前

1. 完全退出 Codex，包括托盘窗口和后台 `ChatGPT.exe` / `Codex.exe`。
2. 不要以管理员身份启动 PowerShell；普通用户权限是默认和预期路径。
3. 启动 `codexfast launch` 后保持该终端进程运行，直到退出 Codex。

使用托盘快捷方式时不需要保持可见终端，但通知区域中的 `CodexFast` 托盘进程必须保持运行。

启动器先使用 `tasklist` 查找 `ChatGPT.exe` 或 `Codex.exe` 候选 PID，再读取进程身份。可执行路径位于当前用户注册的任一官方 Stable/Beta MSIX 根目录下时都会阻止启动；npm 或 `%LOCALAPPDATA%\OpenAI\Codex\bin` 中的 Codex CLI 不会阻止启动。如果无法可靠读取候选进程路径，启动器会 fail closed。

## MSIX 发现与覆盖项

默认情况下，启动器通过当前用户的 `Get-AppxPackage` 发现 `OpenAI.Codex` 或 `OpenAI.CodexBeta`，读取 `AppxManifest.xml`，解析 Package Family Name、Application Id 和 AUMID，然后通过 `IApplicationActivationManager` 携带以下参数激活应用：

```text
--remote-debugging-port=<随机本地端口>
--remote-debugging-address=127.0.0.1
```

Stable 始终确定性优先。若已选择的 Stable 包 runtime target pattern 不兼容，启动器不会静默改为启动 Beta；需要通过 `CODEXFAST_APP_BUNDLE` 明确选择 Beta。尚未列入版本记录但已完成当前用户注册的版本必须精确匹配注册的 `PackageFullName`，单独设置覆盖项不能为未知包建立信任。Publisher、AUMID 的 PFN 和 manifest executable 也必须与所选包一致。

如果当前普通用户环境无法发现 MSIX，启动器会输出错误，不会静默提权。可显式配置：

```powershell
$env:CODEXFAST_APP_BUNDLE = 'C:\Program Files\WindowsApps\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0'
$env:CODEXFAST_APP_EXECUTABLE = 'app\ChatGPT.exe'
$env:CODEXFAST_APP_USER_MODEL_ID = 'OpenAI.Codex_2p2nqsd0c76g0!App'

node .\bin\codexfast launch
```

`CODEXFAST_APP_EXECUTABLE` 可以是相对于 bundle 的路径，也可以是绝对路径，但最终必须精确指向 manifest 声明且位于 bundle 内的 executable。`CODEXFAST_APP_USER_MODEL_ID` 必须使用 `PackageFamilyName!ApplicationId` 格式，其 PFN 必须能由当前用户注册信息或 WindowsApps 路径验证。

## 只读兼容性检查

以下命令不会启动 Codex：

```powershell
node .\bin\codexfast inspect
```

它会重新读取当前 MSIX 身份、manifest、`AppxSignature.p7x` 和 `app.asar`，输出兼容来源、ASAR SHA-256、8 个目标的 archive/runtime 路径与状态。每次 `launch` 都会重新执行检查，不保存长期信任缓存；启动后仍必须从对应 renderer origin、资源路径和原始/已补丁 body hash 观察全部 8 个目标。

自动化和版本审计可使用：

```powershell
node .\bin\codexfast inspect --json
```

JSON `schemaVersion` 当前为 `1`。成功和预期失败都会在 stdout 输出单个 JSON 文档，失败仍使用非零退出码。报告包含包身份、覆盖项是否启用、manifest/ASAR/`AppxSignature.p7x` 文件快照、兼容来源和 8 个目标；`compatibility.verifiedTargetCount` 只统计通过静态归档/替换门禁的目标，不表示 runtime CDP 已观察到这些目标。报告明确标记未启动 Codex、未执行 runtime 验证、未读取 Provider 配置。`ok: true` 只表示静态门禁通过，不代表 UI、Fast request 或 `http://127.0.0.1:8317/v1` 已经真实验证。

## Fail-Closed 行为

已登记版本使用 source `whitelist-signatures`，未列入版本记录但通过全部静态门禁的已注册版本使用 source `signature-compatible-update` 和 classification `unlisted-signature-compatible`。两者在激活前都必须完成只读全归档检查；Windows 启动成功前还必须从真实 CDP Fetch response 中观察到：

```text
Speed setting
Speed service tier allowance
Speed service tier request allowance
Speed service tier conversation fallback
Composer Intelligence Speed menu
Fast slash command
GPT-5.x model list
GPT-5.6 model query selector
```

任一目标未命中时，启动器会：

1. 终止 patch session。
2. 重新核验本次激活 PID 的进程名、启动时间，以及可读取时的可执行文件路径。
3. 仅在身份仍匹配时执行 `taskkill /PID <pid> /T /F`，并确认原进程身份已经消失。
4. 非零退出。

CDP 断开后仍保留上游的心跳和最多三次重连。每次重连都必须重新绑定 app renderer，并重新观察全部 8 个目标；重连耗尽时执行同样的进程树终止流程。helper 会持有已核验进程 handle，复核 PID、进程名、路径、启动时间和本次随机 CDP 参数，再调用 `taskkill /PID <pid> /T /F`。身份无法安全复核时会拒绝终止并输出明确错误。启动器不会按进程名批量关闭应用，也不会关闭启动前已经存在的 Codex 进程。

Windows 的 `taskkill` 接口最终仍按 PID 重新打开目标。微软文档说明 PID 只保证到进程终止为止，因此在外部进程恰好于核验后终止目标并立即复用 PID 的对抗性场景中，仍存在极窄且无法由 `taskkill /PID` 完全消除的理论窗口。当前实现不宣称内核级原子终止保证；完全消除该窗口需要未来改用并真实验证 Job Object 或全 handle-based tree termination。详见 [`docs/windows-compatibility.md`](./docs/windows-compatibility.md)。

## 不会修改的内容

Windows launcher 不会直接写入或替换：

- `app.asar`
- WindowsApps/MSIX 文件
- `AppxManifest.xml`
- Codex 数字签名
- `%USERPROFILE%\.codex\config.toml` 中的 `model_provider` 或 Provider base URL

因此，如果当前 Provider 已配置为 `http://127.0.0.1:8317/v1`，codexfast 不会改变或重定向该请求路径。它只修改当前启动会话内的前端 JavaScript response，实际模型请求仍由用户现有的 Provider 配置决定。用户通过 Codex 原生 Fast/Standard 控件切换速度时，Codex 自身可能通过正常设置路径持久化 `service_tier`；Fast 对应 `service_tier = "priority"`，launcher 不会自行编辑该配置。

这些补丁只启用当前会话内已有的模型和 Fast 前端路径，不会解锁 OpenAI/ChatGPT 服务端模型或 Fast entitlement。代理仍需实际接受 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` 和 `service_tier: "priority"`，也可能自行忽略或拒绝该 tier。

## 手动验证

本仓库的自动测试不会启动或关闭真实 Codex。需要执行真实验证时，在已完全退出 Codex 的独立终端中运行：

```powershell
cd C:\path\to\codexfast-clone
node .\bin\codexfast launch
```

期望启动输出至少包含：

```text
Detected MSIX version: 26.707.3748.0
Required patch targets: Speed setting, Speed service tier allowance, Speed service tier request allowance, Speed service tier conversation fallback, Composer Intelligence Speed menu, Fast slash command, GPT-5.x model list, GPT-5.6 model query selector
Patched targets:
  Speed setting
  Speed service tier allowance
  Speed service tier request allowance
  Speed service tier conversation fallback
  Composer Intelligence Speed menu
  Fast slash command
  GPT-5.x model list
  GPT-5.6 model query selector
Runtime launch completed.
```

保持启动器运行，然后检查：

1. 模型下拉菜单包含 Sol/Terra/Luna，且 reasoning effort 正确。
2. Settings Fast、composer `/fast` 和 Intelligence Speed 菜单都可用。
3. 新会话、已有会话，以及停止后编辑并重发都能在 Fast/Standard 间切换。
4. 本地代理日志中的实际 URL 仍为 `http://127.0.0.1:8317/v1`，model id 与所选 Sol/Terra/Luna 一致，并且 Fast 请求包含 `service_tier: "priority"`。

## 回滚

1. 先完全退出由 codexfast 启动的 Codex。
2. 等待 `codexfast launch` 自行退出。
3. 清除本次终端中设置的覆盖环境变量：

```powershell
Remove-Item Env:CODEXFAST_APP_BUNDLE -ErrorAction SilentlyContinue
Remove-Item Env:CODEXFAST_APP_EXECUTABLE -ErrorAction SilentlyContinue
Remove-Item Env:CODEXFAST_APP_USER_MODEL_ID -ErrorAction SilentlyContinue
```

4. 从开始菜单正常启动 Codex。

没有 bundle 修改、备份文件或签名修复步骤需要撤销。

## 更新兼容性

Codex 更新后，启动器会动态发现新的 hashed chunk 名；只要官方当前用户注册身份稳定、8 个 target pattern 仍各自唯一且内存替换可复核，就可以进入 `unlisted-signature-compatible` classification。target pattern 变化、目标缺失/重复、manifest 或 `AppxSignature.p7x` 文件快照变化、CDP origin/path/hash 不一致都会 fail closed。先运行 `node .\bin\codexfast inspect`；即使通过，也仍需按上面的手动清单验证 UI、Fast 请求和 `http://127.0.0.1:8317/v1` 路由，完成后才能把该版本记录为真实支持。

运行期间 CDP 断开时，launcher 最多重连 3 次。每次重连都必须重新绑定 `app://` renderer；对已经运行的 renderer 先 reload，再主动预载动态资源，并在新的 connection generation 内重新观察全部 8 个标签。单次观察有 15 秒墙钟上限，旧连接的迟到响应不能满足新一代验证。任一步失败都会关闭本次启动且仍属于 launcher 的 Codex 进程树并非零退出。

## License

MIT。保留上游 `Veath/codexfast` 的 License 和作者声明，详见 [`LICENSE`](./LICENSE)。
