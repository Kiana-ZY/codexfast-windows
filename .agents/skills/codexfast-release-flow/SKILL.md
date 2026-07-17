---
name: codexfast-release-flow
description: Use when preparing, validating, tagging, publishing, or verifying a GitHub-only codexfast-windows release from this repository. This repository is private in package metadata and must never be published to npm under the upstream codexfast package name.
---

# CodexFast Release Flow

## Overview

Prepare a verified source release, Git tag, and GitHub release for this independent repository. Never publish this repository to npm.

Use `codexfast-development-flow` first for implementation work. Run release actions only when the maintainer explicitly requests them.

## Hard Boundaries

- Keep `package.json` set to `private: true`.
- Do not run `pnpm publish`, `npm publish`, or registry mutation commands.
- Do not imply that `npx codexfast` installs this repository; that package name belongs to upstream.
- Do not create or move a tag, push, or create a GitHub release without explicit user authorization.
- Preserve `LICENSE` and `UPSTREAM.md` attribution.

## Version Selection

- Use a patch version for corrections to behavior already claimed by this independent repository.
- Use a minor version for a new supported Codex build, feature path, public command, or compatibility surface.
- Use the higher level when one release contains both.
- Never reuse or move an already public version/tag to hide a mistake.

## Release Workflow

1. Confirm the intended code, generated CLI, tests, docs, and manual-validation status are complete. Review `git status --short --branch` and the pending diff.

2. Update release metadata:
   - bump `package.json` only to the approved independent version;
   - move `CHANGELOG.md` unreleased entries into a dated section;
   - align README and compatibility documentation;
   - keep `private: true` unchanged.

3. Run verification:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm build:check
pnpm test
pnpm check:windows-shim
pnpm pack --dry-run
git diff --check
```

Treat `pnpm pack --dry-run` only as package-content inspection. It does not authorize npm publication.

4. Review the generated `bin/codexfast`, package contents, personal-path searches, and the distinction between automated checks and pending real-app validation.

5. Commit only when requested, using `chore: release x.y.z`.

6. Create and push the independent `vx.y.z` tag only when requested. Confirm it points to the intended release commit and does not reuse an upstream tag.

7. Create or update the GitHub release only when requested. Keep release notes aligned with the changelog and state which real-app checks remain manual. Do not upload extra assets by default.

8. Verify the remote tag and GitHub release with `git ls-remote --tags origin` and `gh release view`. A source release is complete only when the expected tag points to the intended commit and the GitHub release contains the expected notes.

## Common Mistakes

- Running an npm publish or registry check copied from upstream workflow.
- Removing `private: true` without a separate package-name and distribution review.
- Claiming `npx codexfast` installs this Windows adaptation.
- Publishing a GitHub release before the generated CLI and full regression suite pass.
- Describing static `inspect` success as real-app validation.
- Tagging a later docs-only commit instead of the approved release commit.
