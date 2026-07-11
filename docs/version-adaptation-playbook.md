# Version Adaptation Playbook

Use this playbook when a new `Codex.app` build appears and `codexfast` needs to adapt safely.

On Windows, run the strictly read-only `codexfast-windows-update-audit` Skill before entering this development workflow. The audit must not edit the repository or launch Codex.

## Goal

Determine whether the new build is unchanged enough for the existing signature profile, update patch logic if needed, and only claim real support after manual validation. macOS remains strict-whitelist based; Windows may use a signature-gated unlisted state without treating it as verified support.

For Windows MSIX adaptations, use `AppxManifest.xml` identity/version plus the mandatory runtime target labels instead of macOS bundle version/build fields. Record the package identity, Package Family Name, Application Id, AUMID, executable, and app.asar hash in `docs/windows-compatibility.md` and a Windows bundle note.

## Steps

1. Identify the build.
   - Read `CFBundleShortVersionString`
   - Read `CFBundleVersion`
   - On Windows, collect the installed package identity through the read-only audit before editing docs
   - Record a new build as `investigating` only after the audit is complete and adaptation work is explicitly authorized

2. Inspect before launching.
   - On Windows, run `node .\bin\codexfast inspect --json`; it does not start Codex or inspect Provider configuration
   - Record whether the result is `whitelist-signatures`, `signature-compatible update`, or blocked
   - Treat `signature-compatible update` as a static compatibility result only, not a real-app support claim
   - On macOS, check whether the detected version/build is already whitelisted before attempting launch

3. Inspect the bundle before patching.
   - Read `docs/feature-scope.md`
   - Read `docs/patch-targets.md`
   - Read the closest prior note under `docs/bundle-notes/`
   - Identify changed filenames, needles, or gated shapes in the new bundle
   - For Fast support, inspect both visible consumers and the source of service-tier state. Settings, `/fast`, and composer Speed targets are incomplete if the shared service-tier hook still blocks custom API users from computing or sending the selected Fast tier.
   - For runtime launch changes, confirm the actual CDP request URLs for renderer JavaScript, not only the archive paths inside `app.asar`
   - On Windows, `codexfast inspect` must prove exact registered identity, stable manifest/ASAR/signature snapshots, globally unique signatures for all eight target IDs, replacement verification, and dynamic renderer resource mapping. `scripts/inspect-app-asar.mts` is only a wrapper around that same gate

4. Update the script narrowly.
   - Keep new regexes or target specs as small as possible
   - Put feature-specific target definitions in `src/targets/speed.mts`, `src/targets/plugins.mts`, or `src/targets/models.mts`
   - Keep shared target builder helpers in `src/targets/builders.mts` and aggregate exported targets through `src/patcher-targets.mts`
   - Preserve runtime launch fail-closed behavior without writing the app bundle
   - Do not widen support claims before validation

5. Update tests in the same change.
   - Extend `test/runtime-launch-flow.mts` for every changed target, runtime path, or new guard
   - Keep `test/re-sign-flow.sh` only as the macOS shell compatibility wrapper
   - Keep unsupported/incompatible blocking coverage and Windows `signature-compatible update` positive/negative coverage intact
   - When runtime launch changes, cover generated single-file behavior, not only source-level patch helpers

6. Update docs in the same change.
   - `docs/compatibility-matrix.md`
   - `docs/patch-targets.md` if target mapping changed
   - a new note under `docs/bundle-notes/`
   - `README.md` and `README.zh-CN.md` if support scope changed materially

7. Verify.
   - `pnpm build:check`
   - `pnpm typecheck`
   - `pnpm check:version-drift`
   - `pnpm test:windows` for Windows changes
   - `pnpm test` before merging or releasing the adaptation
   - Manual checks from `docs/real-app-validation.md` when claiming real-app support
   - For runtime launch support, verify launch success on the installed app and confirm `app.asar`, `Info.plist`, and the app signature are unchanged

8. Only after verification, add a macOS build to the strict whitelist in `src/supported-app-versions.mts` or a Windows package/version to `src/supported-windows-app-versions.mts`.

For Windows, add the package identity/version only after all eight targets have fixtures, read-only installed-archive verification, and the real-app checklist has passed. An unlisted version may run as `signature-compatible update`, but a recorded entry never replaces the runtime requirement to revalidate snapshots and observe all eight labels from their expected origin/path/hash.

## Stop Conditions

- Do not add a build to the whitelist before test coverage and at least one successful validation pass.
- Do not describe a build as supported if any feature path in `docs/feature-scope.md` is still broken.
- Do not describe a Windows `signature-compatible update` as supported until the UI and provider request checks are complete.
