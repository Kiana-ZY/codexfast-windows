# Docs Index

This directory stores long-lived repository knowledge for `codexfast`.

Use these docs for decisions, troubleshooting, and bundle adaptations that future agents will need to revisit. Do not use this directory as a transcript dump.

## Documents

- [`feature-scope.md`](./feature-scope.md)
  - The current user-facing feature paths exposed by `codexfast`.
- [`compatibility-matrix.md`](./compatibility-matrix.md)
  - Verified `Codex.app` version/build pairs, support status, and supported feature paths.
- [`windows-compatibility.md`](./windows-compatibility.md)
  - Windows MSIX discovery, supported package versions, AUMID details, target signatures, and validation status.
- [`codexfast-windows-best-practices.html`](./codexfast-windows-best-practices.html)
  - Offline interactive Windows usage guide with copyable commands, persistent checklists, update gates, and rollback steps.
- [`patch-targets.md`](./patch-targets.md)
  - High-level mapping from exposed features to the current runtime patch targets.
- [`../src/`](../src/)
  - TypeScript source for the generated `bin/codexfast` entrypoint.
- [`troubleshooting.md`](./troubleshooting.md)
  - Common failure modes, expected boundaries, and recovery steps.
- [`real-app-validation.md`](./real-app-validation.md)
  - Manual smoke-test checklist for real installed `Codex.app` validation.
- [`version-adaptation-playbook.md`](./version-adaptation-playbook.md)
  - Step-by-step flow for adapting `codexfast` to a new Codex build safely.
- [`release-process.md`](./release-process.md)
  - The independent repository's GitHub-only release policy and validation checklist.
- [`bundle-notes/`](./bundle-notes/)
  - Bundle-specific adaptation notes for inspected Codex builds.

## Agent Workflows

- [`.agents/skills/codexfast-windows-update-audit/SKILL.md`](../.agents/skills/codexfast-windows-update-audit/SKILL.md)
  - Strictly read-only Windows MSIX update audit using `inspect --json`.
- [`.agents/skills/codexfast-development-flow/SKILL.md`](../.agents/skills/codexfast-development-flow/SKILL.md)
  - Source, test, generated CLI, and documentation workflow for authorized changes.
- [`.agents/skills/codexfast-release-flow/SKILL.md`](../.agents/skills/codexfast-release-flow/SKILL.md)
  - GitHub-only release workflow; npm publication is prohibited for this repository.

## Writing Rules

- Record reusable conclusions, not raw chat history.
- Prefer concrete facts: bundle version, build number, target files, gate signatures, verification results, and release outcomes.
- Keep each document focused so agents can load the minimum needed context.
