# Repository Guide

## Layout

```text
JAM/
├── .github/              # CI, releases, dependency updates, issue and PR forms
├── docs/                 # Architecture, operations, releases, and audit records
├── functions/            # Server-side functions; secrets stay here or in platform storage
├── migrations/           # Ordered, immutable database changes
├── public/               # Static browser assets and hosting headers
├── scripts/              # Integration and environment verification scripts
├── src/
│   ├── assets/           # Application-owned images and other bundled assets
│   ├── components/       # Reusable UI units
│   ├── hooks/            # Stateful React behavior
│   ├── lib/              # Framework-independent clients and utilities
│   └── pages/            # Route-level UI
└── package.json          # Commands, runtime constraints, and current version
```

This structure is intentionally shallow. Add a new top-level directory only when it has a distinct lifecycle or toolchain. As features grow, group closely related components, hooks, and tests by feature rather than creating many global type-based folders.

## Engineering practices

- Keep `main` deployable and use short-lived pull request branches.
- Make CI the minimum merge gate; add unit and end-to-end test jobs as test coverage is introduced.
- Prefer small modules, explicit boundaries, and types at network or database edges.
- Validate all client input server-side and enforce authorization in the database or server function, not only in the UI.
- Keep deployed migrations immutable and make new migrations safe for existing data.
- Record decisions that are costly to reverse as short architecture decision records in `docs/decisions/`.
- Pin reproducible dependency state with `package-lock.json`; let Dependabot propose reviewable updates.
- Treat warnings, dependency alerts, secret scanning results, and failed CI as maintenance work, not background noise.

## Change lifecycle

```text
Issue or discussion → short-lived branch → pull request → CI and review → squash merge → release tag
```

User-visible changes go into the changelog's `[Unreleased]` section. Pull requests explain verification and operational risk. Version bumps happen in a dedicated release pull request, and immutable `vX.Y.Z` tags trigger release automation.

## Suggested future improvements

Add these when their value exceeds their maintenance cost:

1. Unit tests for pure synchronization, session, and metadata utilities.
2. Component tests for room entry, queue moderation, and authentication states.
3. End-to-end tests for multi-user room flows against an isolated test backend.
4. Preview deployments for pull requests.
5. A `CODEOWNERS` file after review ownership is shared by named maintainers or teams.
6. Architecture decision records for backend-provider, realtime-protocol, and authentication changes.
