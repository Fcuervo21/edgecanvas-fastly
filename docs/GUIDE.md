# EdgeCanvas guide: how it works when hosted

One Fastly Compute service serves the game, the account API and the rooms. State lives in a KV Store, secrets in a Secret Store, live updates through Fanout. There is no other server. Design record: [ARCHITECTURE.md](ARCHITECTURE.md).

## How it works

**Organizer (once).** Upload the roster, then issue one single-use registration code per person. The CSV never leaves the organizer's computer; only the parsed roster goes to the private KV Store, and never into the website's files.

```sh
export EDGE_ADMIN_TOKEN="$(cat compute/.secrets/admin_token)"   # hosted: the value stored in the Secret Store
npm run edge:admin -- upload --url https://YOUR-SERVICE
npm run edge:admin -- enroll --url https://YOUR-SERVICE --player "EXACT_ROSTER_PLAYER_ID" [--organizer]
```

Each code is tied to one exact roster player, expires after 24 hours and works once. Deliver it privately to the verified person and delete the file in `.local/`. Use at least two organizers: recovering an account needs one.

**Player.** Opens the site, creates an account with a username, a password of 15+ characters (common or breached passwords are refused) and the code. From then on they sign in with username and password. The account is bound to their roster place: they cannot change player, team or role, and they only ever see their own step history. Sessions last 8 hours in an HttpOnly cookie; signing out ends the session and its live stream.

**Live drawing and scoring.** `POST /api/rooms/CODE/ink` publishes a drawing preview to the room channel; it is authorized by an HMAC ticket in the room view (2 hours) and reads/writes no storage except a sampled rate-limit record, which is why it is fast. The scoreboard is computed in the browser from the board; each closed day's leader is stored in the shared clock record.

**Fresh start.** `npm run edge:admin -- reset --url … --host "PLAYER_ID"` opens a new empty room (day 1, every wallet zero) and takes the old rooms off everyone's lists; accounts and step histories are untouched. Use it after test sessions and before sharing the game.

**Play.** The organizer creates a room and hosts it. Everyone joins from the lobby and paints one shared 100 × 100 board. Paint is personal (one step = one paint), teams share territory, only the host advances the day (by hand, or on a daily schedule the host turns on: the first request after the chosen time moves the shared clock, missed days are caught up, and it never passes the last recorded day). The calendar moves through the 62 recorded days (July 1 to August 31); on the last day the button becomes "Keep walking!" and the game waits for new steps. Adding days later needs a new dataset version applied to existing rooms (not built yet).

**Lost password.** An organizer issues a 15-minute recovery code from Manage accounts; the player redeems it on the sign-in page. All their old sessions end.

## Protections (all covered by tests; the KV limiter was also run against the compiled service in Viceroy)

| Threat | Limit |
|---|---|
| Password guessing | 5 failed sign-ins per account per network and 50 per account overall, per 15 minutes. Successful sign-ins never count, so guessers are locked out and account owners are not. |
| Credential attempts from one network | 120 sign-in, registration or recovery attempts per 15 minutes (IPv6 per /64). High enough for a whole roster behind one office address; failed-login limits per account do the real guarding. |
| Made-up session cookies | 40 per minute per network, then 429. Visitors with no cookie are never counted; a valid session is never refused because of it. |
| Organizer token guessing | 10 failures per network per 15 minutes. |
| One player flooding the game | 40 commands per 10 s, 30 room views per minute, 12 live subscriptions per minute. |
| Room spam | 5 rooms per organizer per hour. |
| Big or malformed bodies | Declared size checked before reading; JSON must be an object. |
| Cost per painting command | One publish request per command, however many tiles it changes. Version hints from clients are ignored. |
| Plain HTTP | Redirected (pages) or refused (API); cookies are always `Secure` when hosted. |
| Stale records | Rate-limit slots, recovery lookups and sessions expire on their own (KV TTL). |

Limits are fixed windows, so a burst can briefly reach twice the figure at a window boundary. Counters live in KV, so they are global rather than per location.

## Cost and spending controls

Estimated **1 to 12 USD per month** for 23 players (Fastly's published free allowances cover Compute, Fanout and bandwidth; KV writes dominate). This is an estimate from Fastly's pricing page; confirm it in the billing console. There is no hard spending cap, so:

1. Set a **spend alert** (Account, Billing, Spend alert), for example at 20 USD. It notifies at 80% and 100%; it does not stop anything.
2. Know the **kill switch**: `fastly service-version deactivate --version=active --service-id SERVICE_ID` takes the game offline immediately; `fastly service delete` removes it.
3. Bogus traffic costs roughly 2 USD per million requests (a Compute request plus a few KV reads). The limits above cap it per network, not globally; a large distributed flood is a Fastly DDoS-protection matter.
4. Use a **deploy token** with an expiry and scope it to the service after creating it. Turn on two-step verification for the account.

## Deploying

```sh
sh compute/scripts/provision.sh SERVICE_NAME DOMAIN      # service, domain, TLS backends, KV, secrets, package, Fanout trial
```

The script cannot create the Fanout publish token (that needs the account password). Create an API token limited to the new service in the Fastly console and load it yourself, in your own terminal so the value never appears anywhere else:

```sh
fastly secret-store-entry create --store-id SECRET_STORE_ID --name fanout_api_token
```

Without that token everything works except live pushes: the browser falls back to refreshing every 5 seconds. Then upload the roster and issue codes (see "How it works"). To ship a change: `npm run compute:build`, then `cd compute && fastly compute deploy --service-id SERVICE_ID --package pkg/edgecanvas-edge.tar.gz`.

## What was measured on the real platform (September 29, 2026, on a disposable test service with synthetic data)

All 22 checks of the end-to-end script passed: registration, sign-in, room creation, joins, paint, idempotent retries, single-use codes under 12 simultaneous attempts, logout ending the held Fanout stream, and the abuse limits answering 429.

- **KV insert-if-absent is atomic**: in 5 rounds of 16 simultaneous inserts of one key, exactly one won every time. Conflicts surface as `TypeError: KVStore insert: Precondition failed`.
- **The 50 ms CPU limit in the docs is not enforced as a cut-off**: password hashing runs, but takes about 2.5 to 3.5 s per sign-in or registration.
- **Latency from a home connection**: sign-in about 2.4 s, painting about 2.5 s per command (p95 3.1 s), loading a room about 1.6 to 2 s, another player's write visible in about 3 s. Missing-key lookups cost about 160 ms each and writes about 200 ms; every versioned read ends with one missing-key lookup. Idle instances start cold and add up to about 1 s to a request. Fanout delivery, measured on the live service with `npm run edge:admin -- live`: 120 of 120 pings delivered, publish-to-visible median 120 to 180 ms, 95th percentile about 1 s (includes the publish request's round trip and occasional cold starts; measured from a home connection).
- **Platform quirks the local emulator hid**: KV `list` refuses prefixes containing `/` or `:` (listable key families now use `-`); Fanout's handoff response must be returned untouched (re-wrapping the response silently disables streaming); Edge Rate Limiting counters do not exist in Viceroy (replaced by KV limits).

**Why painting feels immediate.** Saving a move takes 1.5 to 2.5 s on the real KV Store (traced on the live platform: authentication about 70 ms, then a sequence of remote reads and writes of 160 to 400 ms each). So the browser paints the player's own moves at once (the confirmed room plus moves the server has not answered yet; confirmed data always wins), groups strokes drawn while a request is in flight into one request, and the server saves a command's tiles in parallel, runs the rate limit alongside the reads, finds the clock from its recent version and closes the wallet record right after answering. Other players see a move about 2 s after it is drawn (save time plus a push of about 120 ms), arriving in batches while someone holds the mouse.

**Game-style smoothness.** The screen follows the usual fast-paced multiplayer pattern. *Your own moves* are predicted locally and reconciled with the server's answer (confirmed data always wins). *Other players' moves* arrive as events and are shown with a small deliberate delay: their new pixels are revealed one after another, in the order received and spread over a short bounded time (at most about 0.4 s per batch, chained so a long line draws left to right and never more than half a second behind), instead of appearing all at once. Updates caused by drawing are capped at about 30 a second, the confirmed room is copied shallowly instead of cloned, and the step-history strip and team chips are only rebuilt when they change. A bomb or shield announces where it landed and for which team (an `fx` event ahead of its tiles), so every screen plays the splash at the right place instead of using the receiver's own cursor and tool.

Broadcasting a move before it is persisted and correcting it when the saved tiles arrive is now in place (drawing previews, see "Live drawing and scoring" above). Head pointers for versioned records (skip the missing-key lookup on reads and let the atomic `add` detect staleness on writes) remain a further optimization.

## Run it locally (macOS)

```sh
npm ci && npm run check
npm run compute:build && node compute/scripts/local-secrets.mjs
sh compute/scripts/local-pushpin.sh                       # Fanout emulator, loopback only (brew install pushpin)
cd compute && "$HOME/Library/Application Support/fastly/viceroy" serve -C fastly.toml \
  --addr 127.0.0.1:7676 --local-pushpin-proxy-port 7677 bin/main.wasm   # run from compute/: secret paths are relative
```

The Fastly CLI downloads Viceroy the first time you run `fastly compute serve`. The local KV lives in memory, so restarting Viceroy clears accounts and rooms.
