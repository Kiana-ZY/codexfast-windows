---
name: codexfast-windows-update-audit
description: Perform a strictly read-only compatibility audit of an installed Windows OpenAI Codex or CodexBeta MSIX against the codexfast-windows repository. Use after Codex updates, when `codexfast inspect` blocks or reports a signature-compatible update, or when package identity and runtime-target evidence is needed before adapting or recording a Windows build. Never launch, activate, patch, repair, reinstall, re-sign, or edit Codex, the repository, user configuration, or provider settings.
---

# CodexFast Windows Update Audit

Audit the installed Windows package without changing the app or repository. Treat a static pass as evidence for later validation, never as proof that the real UI or provider request path works.

## Safety Boundary

- Do not run `launch`, tray/shortcut installers, application activation, `taskkill`, or any command that starts or stops Codex.
- Do not unpack/repack/re-sign/reinstall MSIX, replace `app.asar` or `codex.exe`, trust certificates, write the registry, or request UAC.
- Do not edit `config.toml`, Provider settings, model routes, plugin state, credentials, history, or caches.
- Do not edit, stage, commit, switch, reset, clean, or otherwise mutate the Git worktree.
- Do not install dependencies, run `pnpm build`, self-update a Skill, or execute scripts from external patch repositories.
- Do not copy code, regexes, prompts, patches, or assets from an external repository without a compatible license.

## Audit Workflow

1. Confirm the host is Windows. Read `AGENTS.md`, `docs/feature-scope.md`, `docs/windows-compatibility.md`, `docs/patch-targets.md`, `docs/version-adaptation-playbook.md`, the newest relevant Windows bundle note, and `src/supported-windows-app-versions.mts`.

2. Record the starting state with read-only commands:

```powershell
git rev-parse HEAD
git status --short --branch
node --version
node .\bin\codexfast version
```

Preserve an already dirty worktree. Do not hide or repair existing changes.

3. Run the authoritative static inspection:

```powershell
node .\bin\codexfast inspect --json
```

The JSON report must have `schemaVersion: 1`. Parse it as structured data; do not scrape human-readable output when JSON is available.

4. Verify the report contract:

- `scope.readOnly` is `true`.
- `scope.codexLaunched`, `runtimeVerificationPerformed`, and `providerConfigurationInspected` are `false`.
- Package identity, PackageFullName, Publisher, PFN, Application Id, AUMID, executable, and registration status are explicit.
- Manifest, ASAR, and `AppxSignature.p7x` are described as file snapshots with path, SHA-256, size, and mtime. Do not call the signature cryptographically verified.
- A successful report contains exactly eight verified targets, each with id, label, state, archive path, runtime path, original body hash, and patched body hash.
- `runtimeVerificationRequired` remains `true` for every static pass.

5. Classify the result:

- `recorded-static-pass`: `ok: true` and source `whitelist-signatures`.
- `unlisted-signature-compatible`: `ok: true` and source `signature-compatible-update`.
- `blocked`: a discovery or compatibility error caused by package identity, manifest, ASAR, signature-file snapshot, or target mismatch.
- `tooling-error`: the generated CLI or required local tool cannot run.

Neither successful classification is a real-app support claim.

6. Optionally run existing non-launching checks only when dependencies are already installed:

```powershell
pnpm build:check
pnpm typecheck
pnpm check:version-drift
```

If `pnpm`, dependencies, or the generated CLI are unavailable, report that limitation. Do not install or rebuild them during this audit.

7. Re-run `git status --short --branch`. If tracked or untracked state changed because of the audit, report the unexpected write and classify the audit as failed.

## Failure Handling

- Preserve the JSON error `stage`, `code`, and `message` verbatim in the audit summary.
- Mention only the supported overrides: `CODEXFAST_APP_BUNDLE`, `CODEXFAST_APP_EXECUTABLE`, and `CODEXFAST_APP_USER_MODEL_ID`.
- Never guess override values, silently switch Stable/Beta, or weaken a target requirement.
- A partial target match is not compatibility. Hand blocked signature work to `codexfast-development-flow` for an explicit implementation task.

## Report

Return a concise audit containing:

- timestamp and repository commit;
- starting and ending Git status;
- CLI and schema versions;
- package identity and selected override flags;
- compatibility classification and source;
- three file snapshots;
- all eight target records on success;
- command exit codes and optional validation results;
- the boundary that real launch, UI, Fast request, and provider routing remain unverified;
- the next handoff: manual real-app validation or `codexfast-development-flow`.
