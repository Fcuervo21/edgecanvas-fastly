# EdgeCanvas

**Turn steps into color.** EdgeCanvas is a shared 100 × 100 canvas where every step you walk becomes paint. Teams
share one color, players keep their own paint, and the whole game runs on **Fastly Compute**: no origin server, no
other cloud.

It was built for the CodeCapsules 2026 steps challenge (23 players, 10 teams, 62 days of real step data) and is
running for real at **https://edgecanvas.edgecompute.app**. Sign-in is invite-only, so the live site is for the players;
this repository is the full source so you can read it, learn from it, or run your own copy.

## The game

- **1 step = 1 paint.** Each simulated day, every player receives the paint of their own steps for that day.
- **Teams share territory.** Everyone on a team paints in the team color; wallets stay personal.
- **Prices.** An empty pixel costs 10 paint, taking over a rival's pixel costs 20, and painting over your own team is
  free. A paint bomb (25 pixels) and a shield (protects up to 9 of your pixels for 2 hours) cost 200 each.
- **Days.** The host moves the shared calendar (by hand, or on an opt-in daily schedule) and everybody refills together.
  After the last recorded day the game says "Keep walking!" and waits for new steps.
- **Scoring.** A day goes to the team with the most pixels when the day closes (a tie has no winner). The champion is
  the team that wins the most days; a tie goes to whoever holds more pixels, and on the last day the current leader
  takes that day too.

## Built on Fastly

| Fastly service | What it does here |
|---|---|
| **Compute** (JavaScript) | Runs everything: sign-in, the game rules, prices, day results and the JSON API. There is no server behind it. |
| **KV Store** | All state: the board (100 tiles of 10 × 10 pixels), each player's wallet, accounts and the private roster. Every record is a write-once, versioned key written with insert-if-absent, so two people painting at the same moment cannot double-spend or overwrite each other. |
| **Secret Store** | The admin token, the password pepper and the token used to publish to Fanout. None of them live in code or in the browser. |
| **Fanout** | Pushes changes to every browser in real time over held streams: new pixels, day changes, bombs and shields, and live drawing previews. |
| **Managed TLS and domain** | HTTPS only. |

### How a move travels

1. The browser paints instantly on your own screen (a prediction) and sends the move to Compute.
2. Compute reserves the price in your wallet, applies the pixels tile by tile (each tile records the command so a
   retry is a no-op), then finalizes the wallet. A request that dies halfway is finished by your next request.
3. Every changed tile is published to Fanout, and other browsers merge it by version number.
4. Saving takes a second or two because of the KV round trips, so while you draw, the browser also sends a
   lightweight **preview** that Compute publishes straight to Fanout without touching storage. Other players see the
   pixels almost immediately as provisional; the saved tiles replace them, and previews that never get saved fade out.
   Previews are authorized by a short-lived signed ticket, so that path needs no account lookups.

The full design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and the guide, including limits, costs and
deployment, is in [docs/GUIDE.md](docs/GUIDE.md).

### Security in one paragraph

Accounts are invite-only: each one-time code is tied to one person on the roster. Passwords are salted and peppered
PBKDF2 hashes, sessions are HttpOnly cookies with a CSRF token, every action is rate limited per person using KV
counters, HTTPS is enforced, and each player's step history stays on the server and out of the website's files. The
protections and their limits are listed in [docs/GUIDE.md](docs/GUIDE.md). Report problems as described in
[SECURITY.md](SECURITY.md).

## Built with AI

The project was built end to end with **Claude Code** and the **Fastly Agent Toolkit**: the Fastly CLI created and
deployed the service, stores and secrets; Viceroy (Fastly's local Compute runtime) and a local Pushpin were used to
test locally; and the Fastly control panel was used to set up Fanout and its publishing token. Tests were written
first for the game rules and the storage protocol. [AGENTS.md](AGENTS.md) holds the working rules for AI-assisted
changes.

## Run it locally

Requires Node 24 (see `.nvmrc`).

```sh
npm ci
npm run check      # tests and a production build
npm run preview    # the solo game on http://127.0.0.1:4173 (uses the sample data)
```

Running the hosted version locally (Compute on Viceroy, Fanout through Pushpin) and deploying it are described in
[docs/GUIDE.md](docs/GUIDE.md) and [compute/](compute/). To deploy your own copy on Fastly:

```sh
fastly auth login
sh compute/scripts/provision.sh my-edgecanvas my-edgecanvas.edgecompute.app
```

## Sample data

`StepsData/sample_step_data.csv` is **synthetic**: 23 invented players in 10 invented teams with 62 days of made-up
steps (including missing days). Replace it with your own CSV in the same format to run a challenge of your own; see
[StepsData/README.md](StepsData/README.md).

## Repository map

| Path | Contents |
|---|---|
| `src/game/` | The rules engine, prices, targets and scoring (pure TypeScript, no I/O). |
| `src/edge/` | The hosted API: routing, accounts, the room authority on KV, rate limiting, Fanout publishing. |
| `src/rooms/`, `src/ui/` | The browser client (prediction, merging, streaming) and the interface. |
| `compute/` | The Fastly Compute service: entry point, manifest, provisioning and local-run scripts. |
| `server/` | A Node server for local rooms and the organizer command line (`npm run edge:admin`). |
| `tests/` | The automated tests. |
| `docs/` | The architecture and the operating guide. |

## License

[MIT](LICENSE)
