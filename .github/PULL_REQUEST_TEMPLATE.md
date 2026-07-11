## Summary

Describe the behavior changed and why it is needed.

## Validation

- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm build:check`
- [ ] `pnpm test`
- [ ] No real Codex process was started or terminated by automated tests
- [ ] `bin/codexfast` was regenerated when TypeScript runtime source changed
- [ ] Compatibility and user documentation were updated when behavior changed

## Safety

- [ ] The change does not modify an installed `app.asar`, MSIX, manifest, signature, or Codex provider configuration
- [ ] Runtime interception still fails closed when required targets are absent
- [ ] No extracted Codex bundle files, personal paths, credentials, or local logs are included
