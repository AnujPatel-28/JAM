# Security Policy

## Supported versions

Security fixes are provided for the latest released version. Upgrade to the newest release before reporting an issue that may already be fixed.

## Reporting a vulnerability

Please do not disclose vulnerabilities in a public issue, discussion, or pull request.

Use GitHub's **Security → Report a vulnerability** private reporting flow for this repository. Include affected versions, impact, reproduction steps, proof-of-concept details, and any suggested mitigation. Avoid accessing data that is not yours and stop testing if it could affect availability or other users.

You should receive an acknowledgement within seven days. After validation, maintainers will coordinate remediation and disclosure. Timelines depend on severity and complexity.

## Secrets

Only browser-safe anonymous credentials may use the `VITE_` prefix. Service keys, cleanup tokens, and Turnstile secret keys must remain in server-side secret storage. If a secret is exposed, revoke and rotate it immediately; deleting it from Git history is not sufficient.
