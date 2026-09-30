# Security

## Reporting a problem

Please report vulnerabilities privately through GitHub's *Report a vulnerability* button on the repository's Security
tab. Include a minimal, synthetic reproduction and the affected path or version. Do not post real invitations,
access tokens or personal data in public issues.

## What is (and is not) in this repository

- No credentials are committed: tokens, the password pepper and Fanout publishing tokens live in the Fastly Secret
  Store (or in git-ignored files under `compute/.secrets/` for local runs).
- `StepsData/sample_step_data.csv` is synthetic. Real step data is personal data; if you run your own challenge, keep
  your CSV out of git and out of the website's files (the hosted build never bundles it).
- CI scans the source and history for secrets, audits dependencies, runs the tests and builds on every push.

## Design notes

The protections the hosted service applies (invite-only accounts, salted and peppered PBKDF2 passwords, HttpOnly
sessions with CSRF tokens, per-person rate limits kept in KV, HTTPS only) and their known limits are in
[docs/GUIDE.md](docs/GUIDE.md). The local Node server (`server/`) is a development tool: it binds to `127.0.0.1`
and must not be exposed to the internet.

## Before you push a change

```sh
npm run check
npm audit --audit-level=high
git diff --check
git status --short
```
