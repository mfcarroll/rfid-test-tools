# Chameleon Ultra daily firmware

The firmware I run on my own Chameleon Ultras, for anyone who wants the same: upstream `main` plus my fixes and
features, most of them in open pull requests. The page lists what the build adds, with links to the PRs, and flashes
it. Stock v2.3.0 is under "Other firmware" to go back.

Live at https://mfcarroll.github.io/rfid-test-tools/chameleon/daily/ (Chrome or Edge on a computer, over USB).

## How it updates

Each published build replaces `firmware/daily.json` and the DFU here, force-pushes the fork's
[`daily`](https://github.com/mfcarroll/ChameleonUltra/tree/daily) as one commit on upstream `main` with the same
source, and adds a `fw-daily-<commit>` release. The page reads `daily.json`, so it needs no edits for a new build.

`daily.json` holds the version the firmware reports, the commit, the publish time, the DFU's file name, the upstream
commit it builds on, the fork commit with its source, and the changes: each one's title, PR number and link (or
none), and state (`open`, `merged`, `closed`, `no PR` or `daily only`).

## Files

| file                    |                                          |
| ----------------------- | ---------------------------------------- |
| `index.html`, `main.js` | the page                                 |
| `firmware/`             | `daily.json` and the current build's DFU |
