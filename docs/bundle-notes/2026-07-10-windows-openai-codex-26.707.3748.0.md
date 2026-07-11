# Windows OpenAI.Codex 26.707.3748.0

## Summary

- Platform: Windows 10/11 x64
- Package: `OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0`
- AppxManifest version: `26.707.3748.0`
- Executable: `app/ChatGPT.exe`
- AUMID: `OpenAI.Codex_2p2nqsd0c76g0!App`
- Validation date: `2026-07-10`
- Status: `recorded-static-pass`; read-only runtime target patterns and automated lifecycle tests passed; real launch pending

## Target Shape

- Settings Fast matches `speed-setting-destructured-option-count` in `webview/assets/general-settings-Dtfq14Yt.js`.
- Custom-provider allowance and existing-conversation fallback match `speed-service-tier-allowance-26601` and `speed-service-tier-conversation-fallback-26707` in `webview/assets/use-service-tier-settings-uyaJ6nX6.js`.
- Request propagation matches `speed-service-tier-request-allowance-26707` in `webview/assets/read-service-tier-for-request-D2fynmwS.js`.
- The Intelligence Speed menu and `/fast` match `intelligence-speed-menu-options-boolean-code` and `service-tier-slash-command` in `webview/assets/composer-Bt9Tt576.js`.
- The priority/source/timeout `list-models-for-host` wrapper matches `gpt5x-model-list-options` in `webview/assets/app-main-BEs0GGm0.js`.
- The `use_hidden_models` selector with `enabledReasoningEfforts` and `includeUltraReasoningEffort` matches `gpt56-model-query-selector` in `webview/assets/model-queries-DYpQPsG6.js`.
- Sol and Terra expose Max and Ultra. Luna exposes Max and intentionally omits Ultra.
- Fast is represented by model `serviceTiers` metadata with id `priority`; it is not a separate model id.

## Windows Runtime Rules

- The Windows profile filters the aggregate target list to exactly six Fast targets and two model targets.
- MSIX discovery and manifest parsing run without elevation.
- Activation uses `IApplicationActivationManager`, not direct mutation or executable replacement.
- Existing process detection uses `tasklist` for `ChatGPT.exe` and `Codex.exe`.
- Failure cleanup uses only the PID returned by activation: `taskkill /PID <pid> /T /F`.
- All eight Fast/model labels are mandatory initial targets. The six lazy renderer resources are preloaded through the active Fetch interception session so a version match alone is insufficient.
- These filenames are the audited baseline only. Future official current-user registered updates may derive new filenames dynamically, but only after all eight target patterns remain globally unique, manifest/PFN/AUMID/executable identity is exact, and the target response origin/path/hash gate succeeds. Such a run is classified as `unlisted-signature-compatible`, not as verified support for this baseline.

## Read-Only Archive Check

- AppxManifest.xml size: `3711`
- AppxManifest.xml SHA-256: `faeb5337747668c2e2d091e75e6711e5e6d66e2c1b4fcf76c7b8a87c12aa8f42`
- app.asar size: `199246396`
- app.asar SHA-256: `8569b806651ba64c7a0d2fb2e072d4616f37dfe9a057be6ec829b6fa1c193b10`
- AppxSignature.p7x size: `12210`
- AppxSignature.p7x SHA-256: `4F6FFC2F2F4396BADD9F8F14F341B52F33B115107EBA3127DE0F05D852321786`
- Result: all eight target patterns guarded; in-memory replacements re-matched their patched target patterns; before/after hash and metadata unchanged

## Deferred Validation

Automated validation does not activate, close, or restart the installed Codex instance. Run the manual flow in `README.windows.md` from an independent session, then verify the model picker, Settings Fast, `/fast`, Intelligence Speed, existing-conversation and stop/edit/resend behavior. Proxy logs must confirm the configured `http://127.0.0.1:8317/v1` route, selected model id, and `service_tier: "priority"` for Fast before this status is promoted from `recorded-static-pass` to `supported`.
