# Contributing

Thank you for helping improve `codexfast-windows`.

## Before You Start

- Read `AGENTS.md` and the relevant documents under `docs/`.
- Open an issue before broad compatibility or architecture changes.
- Do not commit extracted Codex application files, MSIX contents, `app.asar`, credentials, logs, or personal absolute paths.
- Keep the runtime launcher read-only with respect to the installed Codex application.

## Development Setup

Requirements:

- Node.js 18.12 or newer
- Corepack or pnpm 10.33.0
- Windows 10/11 x64 for Windows-specific helper tests

```text
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

The published launcher file is generated. Edit TypeScript under `src/`, run `pnpm build`, and commit `bin/codexfast` with the source change.

## Pull Requests

- Use a focused branch and a Conventional Commit subject.
- Add positive and negative regression coverage for patch signatures and fail-closed behavior.
- Keep Windows and macOS platform scopes explicit.
- Update English, Chinese, Windows, compatibility, or release documentation when the behavior changes.
- Automated tests must not start, close, or modify a real Codex installation.

Real installed-app validation is manual and must follow `docs/real-app-validation.md`.

## License

By contributing, you agree that your contribution is licensed under the repository's MIT License.
