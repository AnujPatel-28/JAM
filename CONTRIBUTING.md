# Contributing to JAM

Thanks for helping improve JAM. Small, focused pull requests with a clear reason and verification are easiest to review.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- For a bug or small improvement, open an issue or submit a focused pull request.
- Discuss large features, schema changes, security-sensitive work, or architectural changes in an issue before implementation.
- Never include credentials, private URLs, user data, or production database content.

## Local setup

Requirements: Node.js 22 or newer, npm 10 or newer, and an InsForge project for backend-dependent behavior.

```bash
git clone https://github.com/AnujPatel-28/JAM.git
cd JAM
npm ci
copy .env.example .env
npm run dev
```

On macOS or Linux, use `cp .env.example .env`. Use only a browser-safe anonymous key in variables beginning with `VITE_`.

## Development workflow

1. Create a branch from an up-to-date `main` branch.
2. Use a descriptive name such as `feat/queue-reordering`, `fix/room-expiry`, or `docs/local-setup`.
3. Keep commits coherent. Conventional Commit prefixes are encouraged: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `build:`, `ci:`, and `chore:`.
4. Run `npm run check` before opening a pull request.
5. Update documentation and `CHANGELOG.md` under `[Unreleased]` for user-visible changes.
6. Complete the pull request template and respond to review feedback.

## Pull request rules

- Target `main` and keep the branch current.
- Prefer one logical change per pull request.
- Explain the problem, the approach, risks, migrations, and verification.
- Include screenshots or recordings for visible UI changes.
- Database migrations must be additive whenever possible, timestamped, reversible through a documented recovery plan, and safe for existing data.
- Do not edit an already-deployed migration; add a new migration instead.
- A maintainer approval and passing CI are expected before squash merging.

Maintainers use squash merge so `main` stays readable. The pull request title becomes the commit subject and should use a Conventional Commit prefix.

## Versioning

JAM uses Semantic Versioning: `MAJOR.MINOR.PATCH`.

- `PATCH` fixes bugs without intentionally changing behavior for users.
- `MINOR` adds backward-compatible functionality.
- `MAJOR` includes breaking behavior, configuration, API, or migration changes.

Before version `1.0.0`, incompatible changes may be released as a minor version but must be called out clearly. See [docs/RELEASING.md](docs/RELEASING.md) for the release procedure.

## Reporting security issues

Do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
