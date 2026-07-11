# codexfast-windows

[中文说明](./README.zh-CN.md)
[Windows guide](./README.windows.md)

> Independent public adaptation based on [`Veath/codexfast`](https://github.com/Veath/codexfast) `v0.49.1`, with Windows support maintained by [`Kiana-ZY`](https://github.com/Kiana-ZY). This is not an official OpenAI project. See [`UPSTREAM.md`](./UPSTREAM.md).

**A runtime launcher for verified macOS and signature-validated Windows OpenAI Codex Desktop builds that applies session-only UI patches without modifying the installed app bundle or MSIX.**

`codexfast` launches Codex with temporary runtime patches for the current session. It keeps the original `app.asar`, `Info.plist`, app bundle, and app signature untouched.

- **Fast settings** control in Settings
- **Composer `/fast`** slash command
- **Speed submenu** in the composer
- **GPT-5.5 and GPT-5.6 model catalog** metadata for custom API users, including Sol, Terra, and Luna on the latest supported build
- **Disable automatic updates** switch in Settings > General on the macOS profile

```text
git clone https://github.com/Kiana-ZY/codexfast-windows.git
cd codexfast-windows
corepack pnpm install --frozen-lockfile
corepack pnpm build
node ./bin/codexfast launch
```

This independent repository is not the npm package named `codexfast`. Running `npx codexfast` installs the upstream package, so use the clone-local commands above until this project adopts a separately reviewed package name.

Platform profiles are intentionally different:

| Platform | Runtime patch scope |
| --- | --- |
| macOS | Existing upstream Fast, Speed, Plugins, updater, and model targets for whitelisted builds |
| Windows | GPT-5.6 Sol/Terra/Luna plus the complete Fast feature set: Settings, `/fast`, Intelligence Speed, allowance, request propagation, and conversation fallback |

Windows setup, MSIX overrides, fail-closed behavior, manual validation, and rollback are documented in [`README.windows.md`](./README.windows.md).

Verified for `ChatGPT.app` / `Codex.app` `26.707.31428` (`build 5059`), `26.623.141536` (`build 4753`), `26.623.101652` (`build 4674`), `26.623.81905` (`build 4598`), `26.623.70822` (`build 4559`), `26.623.61825` (`build 4548`), `26.623.42026` (`build 4514`), `26.623.31921` (`build 4452`), `26.623.31443` (`build 4441`), `26.616.81150` (`build 4306`), `26.616.71553` (`build 4265`), `26.616.51431` (`build 4212`), `26.616.31447` (`build 4133`), `26.611.62324` (`build 4028`), `26.611.61753` (`build 4008`), `26.611.61049` (`build 3996`), `26.609.71450` (`build 3965`), `26.609.41114` (`build 3888`), `26.609.30741` (`build 3808`), `26.608.12217` (`build 3722`), `26.602.71036` (`build 3685`), `26.602.40724` (`build 3593`), `26.602.30954` (`build 3575`), `26.601.21317` (`build 3511`), `26.527.60818` (`build 3437`), `26.527.31326` (`build 3390`), `26.519.81530` (`build 3178`), `26.519.41501` (`build 3044`), `26.519.31651` (`build 3017`), `26.519.22136` (`build 3003`), `26.513.31313` (`build 2867`), `26.513.20950` (`build 2816`), `26.506.31421` (`build 2620`), `26.506.21252` (`build 2575`), `26.429.61741` (`build 2429`), `26.429.30905` (`build 2345`), `26.429.20946` (`build 2312`), `26.422.71525` (`build 2210`), `26.422.62136` (`builds 2180, 2176`), `26.422.30944` (`build 2080`), `26.422.21637` (`build 2056`), `26.417.41555` (`build 1858`), and `26.415.40636` (`build 1799`). Feature scope: [`docs/feature-scope.md`](./docs/feature-scope.md).

The Windows model and Fast profile has read-only signature validation for `OpenAI.Codex` MSIX `26.707.3748.0`. A newer unlisted Windows package may enter the narrower `signature-compatible update` state only when its current-user registration and package identity match and all eight allowed target signatures are globally unique and verifiable in `app.asar`; that state is not a real-app support claim. A real end-to-end Windows launch remains a manual validation step because this task must not close or restart the active Codex session.

## How It Works

`Codex.app` already contains the Fast, `/fast`, Speed, and updater UI paths in its packaged frontend bundle. `codexfast` patches only the local gates still needed for a verified build. It does not add a backend service or call a private OpenAI API.

`codexfast launch` starts Codex with a local Chrome DevTools Protocol endpoint, attaches through the browser-level CDP target before renderer JavaScript runs, intercepts matching renderer JavaScript responses for that launched session, and applies narrow patch rules in memory. On Windows it activates the MSIX through `IApplicationActivationManager`; no UAC elevation is requested. Keep the `codexfast launch` process running while you use Codex because patched chunks can load lazily.

On Windows, Fast maps to `service_tier: "priority"`; it does not change the selected model id or provider routing. A configured provider such as `http://127.0.0.1:8317/v1` remains responsible for accepting that field and serving the selected model.

On the macOS profile, the Settings > General `Disable automatic updates` switch is stored in Codex desktop configuration as `[desktop].disableAutomaticUpdates`. `codexfast` injects a process-local main-process hook that reads the latest configuration before each Sparkle background update check and automatic forced install scheduling pass. Windows does not enable Sparkle or updater patches.

The launcher sends a lightweight browser-level CDP heartbeat, tries up to three bounded reconnects if the runtime patch session drops, and reports `Runtime patch session lost` instead of silently continuing unpatched. If reconnects are exhausted, `codexfast` closes the launched Codex process and exits non-zero so the session cannot keep running without runtime patching. If the launch process itself is killed externally, fully quit Codex and relaunch with `codexfast` before relying on patched lazy-loaded features.

If an older codexfast version installed the launchd auto-repair watcher, `launch` removes that legacy watcher before starting Codex.

## Usage

Requires Node.js `>=18.12.0`. macOS expects `Codex.app` or `ChatGPT.app` under `/Applications`. Windows expects the current user's `OpenAI.Codex` or `OpenAI.CodexBeta` MSIX; see [`README.windows.md`](./README.windows.md).

Install and build this repository once, then launch from the clone:

```text
git clone https://github.com/Kiana-ZY/codexfast-windows.git
cd codexfast-windows
corepack pnpm install --frozen-lockfile
corepack pnpm build
node ./bin/codexfast launch
```

Inspect Windows compatibility, print help, or print the installed package version:

```text
node ./bin/codexfast inspect
node ./bin/codexfast inspect --json
node ./bin/codexfast help
node ./bin/codexfast version
```

The interactive menu exposes the same launch path:

```text
1) Launch Codex with runtime patches
q) Quit
```

### Command Reference

| Command | Purpose |
| --- | --- |
| `node ./bin/codexfast launch` | Launch Codex with runtime patches for the current foreground session. Keep this command running while you use Codex. |
| `node ./bin/codexfast inspect` | Inspect Windows MSIX identity and all eight required runtime targets without launching Codex. |
| `node ./bin/codexfast inspect --json` | Emit the same static Windows audit as one schema-versioned JSON document for automation. |
| `node ./bin/codexfast help` | Show help. |
| `node ./bin/codexfast version` | Print the codexfast version. |

## Compatibility

The script matches code signatures in frontend build output, so it can break after a Codex update.

- macOS `launch` is blocked unless the installed version/build is whitelisted
- Windows rechecks the registered MSIX identity, manifest, signature file, and the eight exact ASAR target signatures on every run. Unlisted builds proceed only as `signature-compatible update`; no long-term trust cache or version wildcard is used
- Windows additionally fails closed unless all six Fast targets and both model targets are observed from the expected renderer origin, resource path, and inspected body hash before the response is released
- Runtime launch does not rewrite `app.asar`, `Info.plist`, the app bundle, backups, the app signature, or macOS privacy permissions
- On macOS only, the automatic-update switch disables later background update checks and forced automatic install scheduling during the current `codexfast launch` session; Windows does not enable updater patches

## Troubleshooting

**Script fails immediately** - check `/Applications/Codex.app` or `/Applications/ChatGPT.app` exists and `node -v` reports `18.12.0` or later.

**Runtime launch shows `Codex failed to start` / `ERR_FAILED`** - fully quit Codex, rebuild the current clone, and rerun `node ./bin/codexfast launch`. A failed runtime launch should not modify `app.asar`, `Info.plist`, the app bundle, backups, the app signature, or macOS privacy permissions.

**Settings Fast or a patched feature is still missing after `launch`** - confirm the `codexfast launch` terminal process is still running. Closing it ends CDP interception, so lazy-loaded chunks cannot be patched later in the session.

**On macOS, automatic updates still checked once after changing the setting** - the updater can run a startup/background check before the Settings page is opened, and a check that already started cannot be undone. After the switch is enabled, later background checks and forced automatic install scheduling in the same `codexfast launch` session are skipped.

**Runtime patch session lost after reconnect attempts** - codexfast closes the launched Codex process because runtime patching is no longer active. Fully quit any remaining Codex process and rerun `node ./bin/codexfast launch` to start a fresh patched session.

**An older auto-repair watcher was installed** - run `node ./bin/codexfast launch` once from the clone. The launcher removes `~/Library/LaunchAgents/com.codexfast.watcher.plist` and the old local watcher runtime before starting Codex.

## License

MIT. The original `Copyright (c) 2026 Veath` notice is preserved in [`LICENSE`](./LICENSE); repository lineage is documented in [`UPSTREAM.md`](./UPSTREAM.md).
