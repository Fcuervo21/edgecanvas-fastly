# Contributing

Start with [AGENTS.md](AGENTS.md); its rules apply equally to a human contributor and an AI-assisted change.

- Use Node 24 (`.nvmrc`), install with `npm ci`, and run `npm run check` (tests plus a production build) before you
  push.
- Branch from `main`, make one scoped change, and open a pull request describing the behavior, the checks you ran and
  any limitations.
- Write the test first for rules and storage behavior, and watch it fail before you make it pass.
- New tests use synthetic participants only. Never commit real step data, invitations, tokens or credentials.
- All project prose and interface text is in English.
