# EdgeCanvas — guide for AI-assisted changes

Read this first. It applies equally to a human contributor and to a coding assistant.

## Read in this order

1. `README.md`: what the product is and how to run it.
2. `docs/ARCHITECTURE.md`: modules, the storage protocol, real-time design.
3. `docs/GUIDE.md`: hosted operation, protections and limits, deployment.
4. The implementation and tests of the area you will change.

## Working method

- Keep changes small and reuse the existing architecture. Avoid new frameworks, services or databases without a concrete
  need.
- For behavior changes write a failing test first, make the smallest change that passes, then run `npm run check`.
- Report the checks you actually ran and their limits. A two-client test is not a 23-player load test, and a local
  emulator is not the real platform.
- UI text, documentation, comments and commit messages are in English.

## Rules to preserve

- One shared 100 × 100 board per room. Teams own territory; wallets and inventories are individual. At most three
  members per team.
- One step = one paint. Every price lives in `COST` (`src/game/rules.ts`): empty pixel 10, unshielded rival pixel 20,
  bomb 200, shield 200 (protects up to nine own pixels for 120 simulated minutes). Own team paint is free to cross.
- Preview and execution use the same target and cost helpers. Freehand can apply the affordable prefix of a stroke;
  stamps are all-or-nothing; a tool that changes nothing consumes nothing.
- Only the host advances the shared clock (by hand, or on an opt-in schedule). Rooms end with the recorded data: after
  the last day the game says "Keep walking!" (`NO_MORE_DAYS`). Only the solo playground replays history.
- Scoring: each closed day goes to the team with strictly the most pixels; the champion has the most days won, ties
  broken by current pixels; on the last day the live leader also takes that day (`src/game/standings.ts`).
- `balance === earned − spent`. Authoritative records are write-once versioned keys; retry uncertain results under the
  same command ID; ignore stale snapshots. Previews (`ink`) are visual only and never change a price or a balance.
- Missing step data stays missing. Never invent steps.

## Commands

Node 24 (`.nvmrc`), then `npm ci`.

```sh
npm run check       # tests and a typechecked production build
npm run preview     # the solo game on http://127.0.0.1:4173
```

## Security and scope

- Never commit tokens, keys, `.env` files, credentials, Fastly CLI configuration or real participant data. Use synthetic
  identities in fixtures and examples.
- The local Node server binds to loopback and is a development tool; do not expose it.
- Keep authenticated data out of caches and logs. Recheck Fastly's documentation before choosing SDK APIs.
