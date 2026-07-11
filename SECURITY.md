# Security Policy

## Supported Versions

Security fixes are applied to the current `main` branch. Older commits, upstream tags, and unverified Codex Desktop builds are not maintained as separate security support lines.

## Reporting a Vulnerability

Use GitHub private vulnerability reporting:

https://github.com/Kiana-ZY/codexfast-windows/security/advisories/new

Do not open a public issue containing exploit details, credentials, provider secrets, personal paths, or proprietary Codex application files. Include the affected commit, platform, threat model, reproduction steps, and whether the issue can cause installed-app modification, unsafe process termination, non-loopback CDP access, or fail-open patch behavior.

If private vulnerability reporting is unavailable, open a minimal public issue asking the maintainer to establish a private contact channel. Do not include sensitive details in that issue.

## Scope

Reports are especially relevant when they involve:

- modification of `app.asar`, MSIX files, manifests, signatures, or provider configuration;
- unsafe PID ownership or termination behavior;
- accepting non-loopback CDP endpoints or non-app renderer responses;
- bypassing compatibility signatures or required-target checks;
- accidental credential, path, or proprietary bundle disclosure.

The current Windows cleanup path deliberately documents a narrow PID-reuse boundary imposed by `taskkill /PID`; see `docs/windows-compatibility.md`. Reports with a practical reproduction or a maintainable Job Object/handle-based replacement are in scope.
