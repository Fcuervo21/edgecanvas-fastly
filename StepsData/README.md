# Step data

`sample_step_data.csv` is **synthetic**: 23 invented players in 10 invented teams, 62 consecutive days (2026-07-01 to
2026-08-31) with made-up step counts, including missing days. It exists so the project builds, the tests run and the
solo game works out of the box. Nothing in it comes from real people.

## Format

One row per participant. Required columns: `Team Source`, `Name`, `Total Steps`, `Daily Step Goal`, and one column per
day named `YYYY-MM-DD`; days must be consecutive. The distance columns are present in the sample but ignored by the
game. A missing day is empty or `N.A` (it is kept as "no record", never as zero, and never invented).
`Total Steps` must equal the sum of the daily values. A participant's identity in the game is `Team Source:Name`.

The parser and its validation are in `src/data/steps.ts`.

## Running a challenge of your own

Put your CSV in this folder in the same format, and point the imports of `sample_step_data.csv`
(`src/main.ts`, `vite.config.ts`, `server/index.ts`, `compute/scripts/bundle.mjs`) at it. Keep real data out of git:
add its path to `.gitignore`. The hosted build never bundles the CSV; the organizer uploads the parsed roster to the
service's private KV Store with `npm run edge:admin -- upload` (see [docs/GUIDE.md](../docs/GUIDE.md)).
