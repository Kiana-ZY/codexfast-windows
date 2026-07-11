# Windows Compatibility

This document tracks the Windows MSIX launcher contract separately from the macOS `CFBundleShortVersionString` / `CFBundleVersion` matrix.

## Supported Version Keys

Source: `src/supported-windows-app-versions.mts`.

| Package identity | AppxManifest version | Runtime profile |
| --- | --- | --- |
| `OpenAI.Codex` | `26.707.3748.0` | GPT-5.6 models plus the complete Fast feature set, with mandatory observation of all eight required labels |
| `OpenAI.CodexBeta` | `26.707.3748.0` | Same signature-gated model and Fast profile; package not directly installed during this adaptation |

A matching version does not complete compatibility verification. Launch remains blocked unless intercepted JavaScript actually reports all six Fast labels plus `GPT-5.x model list` and `GPT-5.6 model query selector`.

An unlisted version can enter `signature-compatible update` without adding a wildcard version entry. This requires an exact current-user registration for the official Stable or Beta PackageFullName, the expected OpenAI Publisher, manifest/PFN/AUMID/executable agreement, stable manifest/ASAR/signature snapshots, and exactly one allowed guarded/patched/legacy signature for each of the eight target IDs across the full archive. Every guarded/legacy replacement is verified in memory and rechecked for idempotency. The status is intentionally weaker than a matrix support claim.

## Installed Package Record

- Package directory: `OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0`
- Identity: `OpenAI.Codex`
- Version: `26.707.3748.0`
- Architecture: `x64`
- Package Family Name: `OpenAI.Codex_2p2nqsd0c76g0`
- Application Id: `App`
- AUMID: `OpenAI.Codex_2p2nqsd0c76g0!App`
- Executable: `app/ChatGPT.exe`
- app.asar: `app/resources/app.asar`

## Read-Only Target Inspection

Inspection date: `2026-07-10`.

- app.asar size: `199246396`
- app.asar SHA-256: `8569b806651ba64c7a0d2fb2e072d4616f37dfe9a057be6ec829b6fa1c193b10`
- AppxSignature.p7x size: `12210`
- AppxSignature.p7x SHA-256: `4F6FFC2F2F4396BADD9F8F14F341B52F33B115107EBA3127DE0F05D852321786`
- `Speed setting`: guarded signature in `webview/assets/general-settings-Dtfq14Yt.js`
- `Speed service tier allowance`: guarded signature in `webview/assets/use-service-tier-settings-uyaJ6nX6.js`
- `Speed service tier request allowance`: guarded signature in `webview/assets/read-service-tier-for-request-D2fynmwS.js`
- `Speed service tier conversation fallback`: guarded signature in `webview/assets/use-service-tier-settings-uyaJ6nX6.js`
- `Composer Intelligence Speed menu`: guarded signature in `webview/assets/composer-Bt9Tt576.js`
- `Fast slash command`: guarded signature in `webview/assets/composer-Bt9Tt576.js`
- `GPT-5.x model list`: guarded signature in `webview/assets/app-main-BEs0GGm0.js`
- `GPT-5.6 model query selector`: guarded signature in `webview/assets/model-queries-DYpQPsG6.js`
- All eight guarded matches were patched in memory and re-recognized by their patched signatures.
- Before/after size, modification time, and SHA-256 were unchanged.

Run the authoritative read-only inspection without starting Codex:

```powershell
node .\bin\codexfast inspect
```

The development wrapper below delegates to the same generated CLI gate:

```powershell
pnpm exec tsx scripts/inspect-app-asar.mts "C:\Program Files\WindowsApps\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0\app\resources\app.asar"
```

## Launch Contract

1. Discover the current user's `OpenAI.Codex` / `OpenAI.CodexBeta` registration with `Get-AppxPackage`, unless explicit overrides select a verifiable WindowsApps package. Stable is deterministic priority and a failed Stable profile never silently falls back to Beta.
2. Parse `AppxManifest.xml` and derive the AUMID from Package Family Name plus Application Id.
3. Use `tasklist` to find `ChatGPT.exe` or `Codex.exe` candidates, then fail when the process identity resolves inside any current-user registered official Stable/Beta MSIX root. Unrelated Codex CLI processes are ignored; unreadable paths fail closed.
4. Activate the AUMID through `IApplicationActivationManager` with a random loopback CDP port, then require the returned process command line to contain that exact port and loopback address before claiming ownership.
5. Enable only the six Windows Fast targets and two Windows model targets in the runtime patcher.
6. Discover and preload the six renderer resources selected by the ASAR profile. Before releasing a target response, require the attached renderer origin, runtime path, input body hash, and complete labels for that resource to match the profile.
7. On initial target failure or exhausted CDP reconnects, re-open and verify the activation PID in a current-user PowerShell helper, hold its process handle through `taskkill /PID <activation-pid> /T /F`, and exit non-zero.

The launcher never requests elevation and never changes the MSIX, `app.asar`, manifest, digital signature, model provider, or provider URL. It does not directly edit `config.toml`; Codex may persist `service_tier` through its normal settings path when the user selects Fast or Standard.

### PID-Based Termination Boundary

The helper verifies PID, process name, executable path, start time, and this launch's random CDP command-line arguments while holding the original process handle. This prevents known pre-existing or concurrently activated Codex instances from being claimed and makes ordinary PID reuse detectable before termination.

It does not make `taskkill /PID` a handle-based atomic operation. Microsoft documents that a process handle remains valid after termination while the PID is only valid until termination. If another actor terminates the verified process after the final identity check and Windows immediately reuses the PID before `taskkill` opens it, a narrow theoretical race remains. See [Process Handles and Identifiers](https://learn.microsoft.com/windows/win32/procthread/process-handles-and-identifiers).

Eliminating that boundary requires a separately designed and real-app-validated Job Object or handle-based process-tree supervisor. Until then, this repository documents the limitation instead of claiming an absolute kernel-level ownership guarantee.

## Optional Tray Launcher

The source clone includes a current-user notification-area launcher. It keeps the required CDP process hidden, stores logs under `logs/launcher.log`, rotates the previous log at 5 MB, and exposes status, retry, log, and project-folder actions through the tray icon. It does not install a service or scheduled task.

The tray refuses to exit while the runtime launcher is active. The user must first quit Codex Desktop so the owned launcher can end normally; this avoids leaving an unmonitored Codex session running after its CDP patch process is killed.

## Validation Status

Completed:

- AppxManifest parsing and installed manifest read
- AUMID and WindowsApps path derivation
- tasklist parsing, MSIX-path process filtering, unrelated CLI exclusion, and process-check error behavior
- Activation Manager argument and PID parsing tests
- exact taskkill PID-tree command tests using a fake runner, held-handle helper compilation, and activation command-line ownership checks
- model and Fast fixture patch tests, lazy-resource preload tests, and Windows-only target filtering
- fail-closed termination tests for missing targets and CDP disconnect
- non-activating tray launcher and temporary shortcut self-tests
- generated single-file CLI build and Windows npm shim check
- read-only installed app.asar signature inspection
- compatible unlisted Stable/Beta synthetic ASARs, all eight missing-target cases, same-file and cross-file ambiguity, signature-only duplicates, malformed ASARs, and manifest/ASAR/signature TOCTOU failures
- CDP renderer-origin/resource-path/body-hash binding, empty waiting-renderer transition coverage, non-app renderer rejection, per-reconnect required-label observation, reconnect setup failure propagation, and loopback/port WebSocket restrictions

Pending:

- Real `codexfast launch` against the installed MSIX
- UI model-picker, reasoning-effort, Settings Fast, `/fast`, and Intelligence Speed verification in the launched session
- Existing-conversation and stop/edit/resend Fast fallback verification
- Confirmation in local proxy logs that requests continue through `http://127.0.0.1:8317/v1` with the selected model id and `service_tier: "priority"` for Fast

Those checks are intentionally manual because closing or restarting the active Codex instance would terminate the current development session.
