# Release Process

This independent repository is currently distributed from GitHub source. It is not published to npm.

## Package Identity

- The npm package name `codexfast` belongs to the upstream maintainer.
- This repository uses the private package identity `codexfast-windows` to prevent accidental registry publication.
- The CLI command remains `codexfast` through the `bin` mapping for local and packaged installs.
- Do not run `pnpm publish`, `npm publish`, or change `private: true` without an explicit maintainer decision and a separate package-name review.

## Preconditions

- Intended code, generated CLI, tests, and documentation are complete.
- `README.md`, `README.zh-CN.md`, `README.windows.md`, `CHANGELOG.md`, and `AGENTS.md` match shipped behavior.
- The relevant real-app checklist is complete before a build is described as validated.
- `LICENSE` and `UPSTREAM.md` preserve upstream attribution.

## Verification

Run from a clean checkout:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm build:check
pnpm test
pnpm check:windows-shim
pnpm pack --dry-run
```

Review `git diff --check`, the generated `bin/codexfast`, package contents, personal-path searches, and installed-app read-only hashes before a release commit.

## GitHub Release Steps

Only perform these steps when the maintainer explicitly requests a release:

1. Select an independent version and update `package.json` and `CHANGELOG.md`.
2. Commit with `chore: release x.y.z`.
3. Create a new independent tag without moving upstream tags.
4. Push the commit and tag to `origin`.
5. Create a GitHub release whose notes distinguish automated validation from manual real-app validation.

Do not create an npm release, GitHub release, tag, fork, or pull request merely as part of ordinary development validation.
