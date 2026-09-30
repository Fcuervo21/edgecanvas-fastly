# Offline password screening data

`password-blocklist.ts` contains SHA-256 lookup values derived from a public password-frequency corpus. It contains no EdgeCanvas passwords, session tokens, participant data or account records. These unsalted hashes are screening data, not a password-storage format; actual account passwords continue to use independently salted scrypt hashes.

## Provenance

- Upstream: [SecLists NCSC list at pinned revision](https://github.com/danielmiessler/SecLists/blob/6b0c02d4c3ccfc0f53a9bebfad46eb58a9101404/Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt).
- Revision: `6b0c02d4c3ccfc0f53a9bebfad46eb58a9101404`.
- Retrieved September 17, 2026 through GitHub's contents API. Original NCSC download links returned 404.
- Original attribution: the NCSC April 2019 analysis of breached passwords from Have I Been Pwned, described in its [2019 annual review](https://www.ncsc.gov.uk/files/NCSC_Annual%20Review_2019%20FINAL%20single%20pages%20V2.pdf).
- Exact upstream bytes: 835,538; SHA-256 `c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0`.
- This upstream file has 99,839 nonempty entries despite its historical 100k filename. The SecLists MIT license is reproduced in `LICENSE`.

## Derivation and behavior

The existing 15-character minimum rejects shorter passwords. The generator lowercases each public entry, retains entries with at least 15 Unicode code points, hashes UTF-8 bytes with SHA-256, deduplicates and sorts. This produces 329 lookup hashes. At registration/recovery the server lowercases the entire proposed password only for this lookup; it does not trim it, reject substrings, or change the password passed to scrypt. Existing login verification is unchanged and remains case-sensitive.

No password, full hash, hash prefix, registration code or CSV leaves the application during screening. No live external service or new package is required. The static TypeScript artifact is imported only by the server; the hosted build rejects server-directory imports.

This is a finite, historical list of commonly used breached passwords, not the complete or latest HIBP corpus and not a password-strength guarantee. Case-insensitive matching catches case-only variants of listed entries; arbitrary substitutions and unlisted breached passwords can still pass. Review dataset freshness and required coverage before the private pilot.

## Rebuild and update

Download the pinned public file to an untracked working location, then run from the repository root:

```sh
node_modules/.bin/tsx server/build-password-blocklist.ts /path/to/public-source.txt
```

The generator checks the exact source checksum before writing and prints only entry counts. It never downloads data. Do not run it on user passwords or private participant files. Changing the corpus requires an explicit provenance/license/checksum review and an intentional generator update. Retain the 15-character minimum unless the generator and coverage tests are also revised. Commit the generated artifact, updated provenance and applicable license together; do not commit a raw corpus or generated files from runtime account data.
