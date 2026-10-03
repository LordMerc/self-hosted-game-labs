# Verification log

Commands run, results, and anything that could not be run. Environment failures are recorded separately from code failures.

## Milestone 1 scaffold (2026-10-03)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | Pass |
| Unit and API tests | `npm test` | Pass, 28 tests (allocator, template validation, /proc/net parsing, slugs, auth and API) |
| Build | `npm run build` | Pass |
| Server smoke test | start `dist/server/index.js`, curl `/api/health`, `/api/auth/status`, first-run setup, authenticated `/api/templates`, SPA fallback | Pass |
| UI | Headless Chromium: first-run login, then Game servers page renders | Pass (screenshot reviewed) |

### Not run (environment)

- `docker compose up` / image build: no Docker daemon in the build environment. The Dockerfile and compose file are unverified.
- Anything touching a real router, Cloudflare, or a game client: not yet implemented, so not verified.
- Milestone 1 acceptance criteria beyond the scaffold (deploy, UPnP, DNS, friend connecting) are open.

## Deploy flow, connectivity, DNS and reconcile (2026-10-03)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | Pass |
| Tests | `npm test` | Pass, 62 tests |
| Deploy flow | service tests against a fake Docker: labels, env ports, data dir, secrets hidden, distinct ports for two servers, error + retry, crash at startup | Pass |
| UPnP provider | tests against recorded-format `upnpc -l` output: parse, add, refuse foreign mapping, remove only own, "UPnP off" error | Pass (fake runner) |
| Cloudflare client | tests against an in-memory Cloudflare: DNS-only, tag comments, refuses untagged records, token not in errors | Pass (fake API) |
| Reconcile | tests: router reboot, deleted CNAME, IP change, stale CNAME, missing container, router unreachable | Pass (fakes) |
| End to end UI | headless Chromium against the real server with a fake Docker: first-run login, deploy dialog, Online, make Public (manual rule appears), confirm rule, live log stream | Pass |

### Not run (environment)

These need real infrastructure and are **unproven**; the matching Milestone 1 acceptance criteria stay open:

- Real Docker daemon: `DockerodeDriver` and the Dockerfile/compose have never run. The `upnpc` output format and flags are written from the miniupnpc documentation and not checked against a real router.
- Real Cloudflare zone and real UPnP router.
- The Palworld image's env var names and ports, taken from the template as written; verify against the image's current docs.
- A friend connecting from outside the LAN.
- The Dragonwilds template (`ghcr.io/runescape/rsdw-dedicated`): env names, ports (7777/udp game, 8888/udp beacon) and data path come from the image's README and compose file, and the image is public on GHCR. Not yet verified: that the container user can write to the bind-mounted data folder the panel creates (if the log shows permission errors, `chown -R 1000:1000` the server's folder), that moving the game port off 7777 keeps the beacon working, and a real join from the game client.

## Compose file (2026-10-03)

- First real deploy attempt by the maintainer, as a Dockhand "From Git" stack, failed with `Compose file not found: compose.yaml`: Dockhand looks for `compose.yaml` and the repo had `docker-compose.yml`. Fixed by renaming to `compose.yaml`.
- Also changed so a stack deploy needs no `.env` file: settings are passed through `environment:` with defaults, and data lives in a named volume instead of `./data`.
- `docker compose config` validates the file (with and without variables set); the server starts with the resulting empty-string values. The image build itself is still unrun.

## Image build fix (2026-10-03)

- Dockhand build failed at `RUN npm ci` (exit 1). Reproduced locally by running `npm ci` with no C toolchain on PATH, like `node:22-bookworm-slim`: `better-sqlite3` has a `binding.gyp` and no install script, so npm runs `node-gyp rebuild`, which needs Python and a compiler.
- Fix: `npm ci --ignore-scripts` (Dockerfile and CI). Verified with no toolchain on PATH: `better-sqlite3` and `argon2` load from their bundled prebuilds, `npm run build` passes, and all 62 tests pass.
- The Docker image build itself is still not run end to end (no Docker daemon in the sandbox).

## Real Docker daemon, driver level (2026-10-03)

A throwaway `dockerd` (vfs storage, no bridge networking) was started in the sandbox and the real `DockerodeDriver` and panel were run against it with a small busybox-based test image that logs continuously:

- create (labelled), start, `state`, stop, remove: pass
- log streaming (stdout and stderr, tail plus follow, abort): pass; the log viewer shows live lines in headless Chromium
- deploy through the UI to Online, then Logs: pass
- found and fixed: image pull is attempted every deploy and failed for images that only exist locally; now falls back to a local copy if the pull fails

Not covered: port bindings (no bridge networking in the sandbox), the Palworld image, UPnP, Cloudflare. The maintainer's own homelab run showed Palworld deploying and reporting Online on Docker 29.6.0.

The maintainer then reported that clicking Logs showed a blank screen on their homelab. It did not reproduce here, including with messy and very fast log output. The log viewer is now hardened (batched updates, ANSI/NUL/carriage-return cleanup, connection status) and the app shows an error message instead of a blank page if a component throws.

## First real hardware run (maintainer's homelab, 2026-10-03)

Host: Ubuntu desktop, Docker 29.6.0, deployed as a Dockhand "From Git" stack. Router: TP-Link Deco X55 (WAN IP is the public IP, no double NAT). Domain on Cloudflare.

| Check | Result |
|---|---|
| Image build and deploy (Dockhand) | Pass after the fixes above (compose file name, `--ignore-scripts`, `pull_policy: build`) |
| Palworld deploy from the panel, data on an external drive via `GAME_DATA_DIR` | Pass; container runs, player joined over the LAN |
| Live logs | Pass after the viewer hardening; the earlier blank screen was a stale image, not a code bug |
| UPnP on the Deco | Pass after a fix: `upnpc -l` finds the router at `http://192.168.50.1:1900/pwpmr/rootDesc.xml` but prints "Found a (not connected?) IGD" and stops, so the panel now retries with `-u <that URL>`. Then `GetExternalIPAddress`, adding and listing mappings all work. `GetStatusInfo failed` in the output is harmless on this router. Mappings appear as `gamelabs: palworld` for 8211/udp and 27015/udp |
| Cloudflare DDNS and per-server name | Pass: A record and `palworld.<domain>` created, DNS only |
| Friend connecting from the internet | Not yet confirmed |

Also found on the way: `upnpc` prints its useful lines on stderr, so the panel keeps stderr too; the router's own address is also reachable when `-m <LAN IP>` pins discovery to the right interface.

## Host stats and per-server usage (2026-10-03)

| Check | Result |
|---|---|
| Typecheck and tests | Pass, 94 tests (`/proc` parsing, rate averaging, Docker stats maths, API) |
| Dashboard in headless Chromium against the real server on a Linux host | CPU, memory, storage and network tiles show live values (screenshot reviewed) |

Not run: per-server CPU and memory against a real container (the Docker stats call is unit-tested with a recorded-format reply only). The CPU figure is a share of the whole host, not per core. Players online is still not reported.

## Live player counts (2026-10-03)

| Check | Result |
|---|---|
| Typecheck and tests | Pass, 99 tests. The A2S query is tested against a real local UDP socket: plain reply, challenge round trip, timeout, malformed replies |
| Palworld on the real server | Not run. The Palworld template now sets `query: a2s` on its query port (27015/udp) and the panel asks `127.0.0.1:<port>`. Whether the Palworld image answers A2S_INFO with an accurate player count is unverified; if the count stays at "up to 32" or shows 0 while someone is online, that is the thing to check |

Only `a2s` is implemented; `query: minecraft` is accepted by the template schema but not queried yet.

## Backups (2026-10-03)

| Check | Result |
|---|---|
| Typecheck and tests | Pass, 107 tests: real `tar` round trips (create, newest-N retention, restore removes files added later, unsafe names refused, a corrupt archive leaves live data untouched), service restore stops and restarts the game and keeps a safety copy, one job at a time per server |
| UI in headless Chromium against a fake Docker | Pass: Backups dialog, Back up now, restore, list of backups (screenshots reviewed) |

Not run: a backup or restore of a real game's data on the maintainer's host. Two things to watch there: file ownership after a restore (the panel runs as root, so `tar` should keep the game's user), and backups being hot copies unless the server is stopped first. Backups are kept in `<game data dir>/.backups/<server>/`, so they sit on the same disk as the world; copy them elsewhere for real safety. `BACKUP_KEEP` (default 7) sets how many are kept per server.

### Backup retention (2026-10-03, maintainer's requirement)

A backup is kept at least 7 days, and deleting a server never removes its backups: `BACKUP_KEEP` only lets a backup go once it is beyond the newest N *and* at least 7 days old, and backups of a deleted server are never pruned. "Delete server and its world data" first takes a final backup, and stops if that fails. To restore after a deletion, create a new server with the same name (same slug) and open its Backups. Tests (110): age and count pruning with back-dated files, final backup on delete, redeploy and restore.

### Per-server backup settings (2026-10-03, maintainer's request)

Each server has "keep up to N backups" and "never delete one younger than D days" in its Backups window (defaults 7 and 7; `BACKUP_KEEP` sets the default N). When a new backup pushes the count over N, the oldest beyond N are deleted, but only those at least D days old; D = 0 means the count alone decides. Settings are stored beside the backups (`.backups/<slug>/settings.json`), so they survive deleting and recreating the server. Lowering N takes effect at the next backup. Tests (113): count-only pruning, per-server storage, validation, persistence across delete and redeploy; UI checked in headless Chromium (3 backups with N=2, D=0 leaves 2).

### Scheduled backups (2026-10-03)

Per-server "back up automatically every N hours" (default 24, 0 = off), checked every 10 minutes and once a minute after startup. A server with no backup yet is backed up on the next check; one that is stopped and already has a backup is skipped. Servers still deploying, in error, or without a data folder are skipped. Same keep rules as manual backups. Tests (116): due, not due, off, stopped, no data folder. Not run for a real day on the maintainer's host; the timer wiring in `src/server/index.ts` is only covered by the service tests, not by a running process.
