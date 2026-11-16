# Pi Client development

This standalone repository is the source of truth for the desktop client.
Run development commands here. The Git remote is
`https://github.com/Duolagon/Pi-client.git`.

Pi is consumed through exact npm dependencies and `package-lock.json`.
Do not copy the upstream monorepo or its Git history into this repository.
See `UPSTREAM.md` for the pinned version and upgrade process.

## Build and verify

- Install with `npm ci --ignore-scripts`.
- Check types with `npm run check`.
- Run backend and renderer state regressions with `node --test test/*.test.ts`.
- Build and package with `npm run package`.
- Verify actual Electron interactions with `npm run verify:client`.
- Regenerate README screenshots with `npm run verify:client -- --screenshots`.
  Inspect both images before committing them.

Tests and screenshots use isolated temporary projects and local scripted
providers. Do not use personal Pi configuration, real credentials or paid
model requests for these checks. Screenshot captions must identify the local
demonstration model.

The formal application is in `src/renderer/`. It also imports shared UI and
styles from `src/prototype/`; retain those source files. Generated prototype
output belongs in the ignored root `prototype/` directory.

## Changes and publication

Keep renderer calls aligned with `src/shared.ts`, preload and IPC contracts.
Document the difference between available backend interfaces and visible
frontend controls. Stage explicit paths and check the staged content for
credentials and local data before pushing. Dependencies, application bundles,
personal settings and session history stay outside Git.
