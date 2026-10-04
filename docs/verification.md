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
- The Dragonwilds template (`ghcr.io/runescape/rsdw-dedicated`): env names, ports (7777/udp game, 8888/udp beacon) and data path come from the image's README and compose file, and the image is public on GHCR. Found on the maintainer's host: the container user (`steam`, uid 1000) could not write to the root-owned folder the panel creates, so the template now declares `owner: { uid: 1000, gid: 1000 }` and the panel sets it when it creates the folder (see "Starting status and folder owner" below). Not yet verified: that moving the game port off 7777 keeps the beacon working, and a real join from the game client.

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
| Friend connecting from the internet | Pass (2026-10-03): a friend joined Palworld from outside the LAN at `palworld.<domain>:8211` |

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

### Palworld correction (2026-10-03, real server)

The A2S row above turned out wrong. On the real server (image v2.8.0) a correct A2S_INFO sent to `127.0.0.1:27015` and to the LAN address from the host itself got no reply at all, and `/proc/net/udp` inside the container showed the query socket listening with a full receive queue and thousands of dropped packets: Palworld opens the port but never reads from it. So the Palworld template no longer uses `query: a2s`. It has a `playerCount` command instead, run inside the container with `docker exec`: `curl` against the image's REST API `/v1/api/metrics` (on by default, port 8212, never published), reading `currentplayernum` and `maxplayernum`. That command was run by hand against the real container and returned the live counts. Also seen: the image ships with `RCON_ENABLED=false`, so the console's `rcon-cli` examples (such as ShowPlayers) fail with "connection refused" until RCON is turned on.

## Backups (2026-10-03)

| Check | Result |
|---|---|
| Typecheck and tests | Pass, 107 tests: real `tar` round trips (create, newest-N retention, restore removes files added later, unsafe names refused, a corrupt archive leaves live data untouched), service restore stops and restarts the game and keeps a safety copy, one job at a time per server |
| UI in headless Chromium against a fake Docker | Pass: Backups dialog, Back up now, restore, list of backups (screenshots reviewed) |

Not run: a backup or restore of a real game's data on the maintainer's host. Two things to watch there: file ownership after a restore (the panel runs as root, so `tar` should keep the game's user), and backups being hot copies unless the server is stopped first. Backups are kept in `<game data dir>/.backups/<server>/`, so they sit on the same disk as the world; copy them elsewhere for real safety. `BACKUP_KEEP` (default 7) sets how many are kept per server.

### Backup retention (2026-10-03, maintainer's requirement)

A backup is kept at least 7 days, and deleting a server never removes its backups: `BACKUP_KEEP` only lets a backup go once it is beyond the newest N *and* at least 7 days old, and backups of a deleted server are never pruned. "Delete server and its world data" first takes a final backup, and stops if that fails. To restore after a deletion, use the Backups page (see below). Tests (110): age and count pruning with back-dated files, final backup on delete, redeploy and restore.

### Per-server backup settings (2026-10-03, maintainer's request)

Each server has "keep up to N backups" and "never delete one younger than D days" in its Backups window (defaults 7 and 7; `BACKUP_KEEP` sets the default N). When a new backup pushes the count over N, the oldest beyond N are deleted, but only those at least D days old; D = 0 means the count alone decides. Settings are stored beside the backups (`.backups/<slug>/settings.json`), so they survive deleting and recreating the server. Lowering N takes effect at the next backup. Tests (113): count-only pruning, per-server storage, validation, persistence across delete and redeploy; UI checked in headless Chromium (3 backups with N=2, D=0 leaves 2).

### Scheduled backups (2026-10-03)

Per-server "back up automatically every N hours" (default 24, 0 = off), checked every 10 minutes and once a minute after startup. A server with no backup yet is backed up on the next check; one that is stopped and already has a backup is skipped. Servers still deploying, in error, or without a data folder are skipped. Same keep rules as manual backups. Tests (116): due, not due, off, stopped, no data folder. Not run for a real day on the maintainer's host; the timer wiring in `src/server/index.ts` is only covered by the service tests, not by a running process.

### Backups page and setting a deleted server up again (2026-10-03, maintainer's request)

A Backups entry in the navigation lists every server's backups, including servers that were deleted (shown under "Deleted servers"). For a deleted server each backup has "Set up again": the panel creates the server again with the same game and the settings it had (passwords included unless replaced), and puts the world from that backup in place before the first start. The settings are kept in `.backups/<slug>/server.json` (readable by the panel only, since it holds passwords), written whenever a backup is made, when the server is deleted, and on every reconcile; backups made before this existed get their file at the next reconcile, and if a server was deleted before that, the dialog asks which game it was and uses the template's defaults. If a data folder is still on disk from the deleted server it is replaced, after a copy is kept as a new backup. The new server starts private unless "Make it public" is ticked. Tests: listing, redeploy with and without saved settings, rename, leftover data, validation. UI checked in headless Chromium against a fake Docker. Not run: a real redeploy on the maintainer's host.

## Starting status and folder owner (2026-10-03)

Found on the maintainer's host during the Dragonwilds setup: (1) the panel said "Running" while the game was still downloading about 5 GB, because UDP-only games cannot be probed from outside and the panel only waited 8 seconds; (2) the game could not write to its data folder, which the panel created as root.

- **Starting:** a running server now shows "Starting" until its game port is open. A TCP game port is probed from the host. For UDP the panel runs `cat /proc/net/udp` (and `udp6`) inside the container through Docker exec and looks for a bound socket on the main game port (the first port in the template). Once seen, that run is remembered (a restart counts as a new run). If it cannot tell (no `cat` in the image, exec fails) it assumes ready, so a server is never stuck on "Starting". The deploy itself is not held up, so a long first download cannot time out into an error. The template's `readiness: log-regex` option is still unimplemented.
- **Folder owner:** a template data entry can set `owner: { uid, gid }`; the panel sets the folder's owner right after creating it (non-recursive, the folder is new) and logs a warning event instead of failing if that is not allowed, for instance on a filesystem that does not support owners. Dragonwilds declares 1000:1000. Palworld's image fixes ownership itself and does not need it.
- **Router warning:** a router that does not answer discovery is asked up to three times; reconcile only reports "No UPnP router found" once it has been missing on two reconcile rounds in a row (about 10 minutes), says it once instead of once per port, and skips stopped servers (their ports are re-checked when the server starts). Discovery prefers a router on this machine's own subnet if another device (for example one at 192.168.1.1) answers first.

| Check | Result |
|---|---|
| Tests | 126 pass: discovery retry, own-subnet preference, router-missing streak, stopped servers, Starting after restart, owner set and owner failure |
| Docker exec against a real daemon (throwaway dockerd, busybox image) | Pass: output demuxed, exit codes, stderr captured, `/proc/net/udp` format matches the parser, missing binary reports exit 127 |
| Real Dragonwilds server | Not run: needs the maintainer's host |

## Server page: settings and console (2026-10-03)

Click a server's name in the table to open its page: overview (address, ports, access, CPU/memory/players), editable settings, a console for games that have one, recent activity, logs and backups buttons, and delete (with or without the world data; deleting data takes a final backup first).

- **Settings:** the panel name changes instantly. Game settings (from the template's `env`) are applied by recreating the container with the new values, so the server restarts; the world folder, ports, router mappings and DNS are untouched, and the image is not pulled again. A setting that is left alone stays as it is; clearing an optional one removes it; clearing a generated password makes a new one; required ones cannot be empty. Passwords are never sent to the page: "Show current" fetches one on request.
- **Console:** a template can declare `console: { exec: [...], examples: [...] }`. A typed command is passed as one argument to that program inside the container through Docker exec (no shell), so text like `; rm -rf /` is just part of the command. Palworld declares `rcon-cli` (the image's own RCON client).

| Check | Result |
|---|---|
| Tests | 134 pass: detail without leaking secrets, name-only change, recreate with new value keeping data and ports, unset/clear/regenerate rules, validation, no pull on apply, console argument handling, stopped server, game without console, route auth and validation |
| Page in headless Chromium against a fake Docker | Pass: open from the table, edit and save, run a console command (screenshots reviewed) |
| Palworld `rcon-cli` on the real image | The template now sets `RCON_ENABLED=true` (the image ships with it off, which made every console command fail with "connection refused"); RCON stays inside the container and is never published. Servers made before this show a notice in the console with one Apply settings button that recreates the container |
| Recreate on a real container with a real data folder | Not run |

## More templates, custom images and the browser test (2026-10-03)

Checked here, in the sandbox, with a throwaway Docker daemon and the real panel code (`DockerodeDriver` + `ServerService`), on the host network because the sandbox has no bridge:

| What | Result |
| --- | --- |
| Terraria (`beardedio/terraria:vanilla-latest`) deployed through the panel | Pass: command line filled in from the settings, container given a terminal, world made on first start, reaches online with the TCP port open, a restart loads the same world instead of making a new one. A bare `-password` at the end (no password) starts fine |
| Satisfactory (`wolveix/satisfactory-server`) deployed through the panel | Starts and begins its SteamCMD download; shows Starting (the UDP check inside the container works); data folder gets `backups`, `gamefiles`, `logs`, `saved`. The 8 GB download and a real game session were not run |
| Valheim, with the Docker Hub copy `lloesche/valheim-server` (older name of the same project) | Starts, both data folders are created, SteamCMD starts. The `ghcr.io/community-valheim-tools/valheim-server` image named in the template could not be pulled from the sandbox (registry blocked), so the new image name is from its README only |
| Minecraft (`itzg/minecraft-server`) | Image pulled and started with the template's settings; the sandbox cannot reach Mojang's download servers, so no world was made. The server list ping is tested against a fake server only |

Not run anywhere: a friend joining any of these; Valheim and Minecraft on the real image names; A2S player counts on Valheim; the Minecraft ping on a real server; Minecraft's `rcon-cli` console; a custom image on real hardware.

Things to check on the homelab:

- Satisfactory shares port 7777 with Dragonwilds. The panel moves Satisfactory (and its other ports) up by one, so players must use the port shown. It needs about 8 GB of free memory.
- Terraria: change the world name later and you get a new world (the old file is kept).
- Backups of Satisfactory and Valheim leave out the downloaded game files; after a restore they stay as they were (or download again if the server was deleted).
- Deploy now finishes once the container has been up for a few seconds. A game that is still downloading or loading shows Starting until its port opens, instead of ending in an error after two minutes.
- Custom Docker image: ports are used exactly as typed (an image cannot be told to move), and a clash is an error.

The browser smoke test (`npm run test:e2e`, runs in CI) drives the built web app with Chromium against the API with a fake Docker: first-run password, deploy a template, choices and required fields, a custom image and a port clash, the server page and console, rename, backup, delete, and set up again from the Backups page, with no browser errors.


## Outside port check

Built against fakes (a fake checker in the service and browser tests, and a fake HTTP server for the check-host.net calls). Not run against the real provider: the build sandbox cannot reach it.

- **What it does:** press **Test** on a server's row, or **Run check** in the Network health panel. For every running public server, each TCP port is sent to check-host.net (`/check-tcp`, then `/check-result`), asking 3 locations to connect to `<public IP>:<port>`. Any location connecting means open; all failing means closed, with the reasons; no usable answer means unknown, with the reason. UDP ports are not tested (a UDP game gives no reply to a bare probe); the panel shows "Router forwards the port" when the router's mapping list (or a rule you confirmed) has it, and "not forwarded" when it does not.
- **Privacy:** nothing is sent unless Run is pressed. What is sent is the public IP and the port number. `PORT_CHECK=off` removes the button's backend.
- **To check on the homelab:** Run on a public Minecraft or Terraria server returns "open" with "Connected from N of 3 locations"; with the server stopped or the rule removed it should say closed. If it says unknown, the detail line names what went wrong (send a screenshot); the provider's response format is the part most likely to need adjusting.

## Per-server CPU and memory limits

| Check | Command | Result |
|---|---|---|
| Typecheck, unit and API tests | `npm run typecheck`, `npm test` | Pass: limits are validated, stored, passed to the container spec, kept when a missing container is recreated, and warned about below a template's minimum (fake Docker) |
| Driver | `test/driver-limits.test.ts` | Pass: `NanoCpus`, `Memory` and `MemorySwap` (equal to `Memory`, so no swap) appear in the create call only when a limit is set (fake dockerode client) |
| Browser | `npm run test:e2e` | Pass: deploy form warning, limit shown in the list and on the server page, change and restart |

### Not run (environment)

- A real Docker daemon: that Docker accepts these values and kills a container over its memory cap is Docker's documented behaviour but has not been seen on the maintainer's host.


## Notifications

Built against fakes: a recording notifier in the service tests, a fake `fetch` for the webhook calls, and a local HTTP server standing in for the webhook in the browser test. Not sent to a real Discord channel: the build sandbox cannot reach Discord.

- **What it does:** Settings → Notifications stores a webhook address encrypted (same scheme as the Cloudflare token), sends a test message on request, and has one checkbox per event. A `discord.com` or `discordapp.com` `/api/webhooks/` address gets an embed with mentions disabled; any other http(s) address gets a plain JSON body (`content`, `text`, `event`, `server`, `title`, `message`, `instance`, `at`).
- **Events:** online (deploy finished, started, or seen running again), down (a running server stopped or errored without the panel stopping it, a deploy that failed, or a container whose start time changed because Docker restarted it), player joined/left (a changed count from the game's query port, polled every 30 seconds; the first reading is only a baseline), backup failed.
- **Quiet on purpose:** stop and restart from the panel are not reported as down; messages carry the server name only, never an address or password.
- **To check on the homelab:** paste a real webhook, press Send test message (expect a green embed in the channel). Stop a game with `docker stop gl-<name>` and expect "went down" within about 30 seconds; start it again for "is online". For a crash, `docker kill gl-<name>` should say "went down", then Docker restarts it and, within the next poll, it should say "online" or "started it again". Join Palworld from the game and expect "1 player joined" (Palworld's A2S count accuracy is itself unverified, see above).


## Restarts, updates and ports

Built against fakes (fake Docker, fake Docker Hub list, fake clock) and the browser test. Not run on the homelab yet.

- **Pinned Palworld image:** `thijsvanloef/palworld-server-docker:v2.8.0`. On 2026-10-03 Docker Hub showed `latest`, `v2` and `v2.8.0` all pointing at the same image (pushed 2026-09-30, before the first world was made), so the pin is the version that has been running. The version list comes from Docker Hub's public API, which was reachable from the build sandbox.
- **Daily restart:** checked once a minute against the panel's local time (`TZ`). A job that was due while the panel was down still runs if it is at most an hour late, otherwise it waits for tomorrow. Palworld's warning is `Broadcast Server_restarting_in_5_minutes.` over `rcon-cli` (Palworld's broadcast only takes one word, so spaces become underscores) and Minecraft's is `say`. **To check on the homelab:** set a restart two minutes away with a 1 minute warning and watch the game chat; the server's activity list says what was sent.
- **Updates:** a tag check downloads nothing. For an image without version tags the panel pulls it and compares image ids. Applying makes a backup (and stops if that fails), removes the container, and starts a new one from the new image with the same data folder. The long download is covered by a test that holds the pull and checks that the server stays "Restarting" and is not rebuilt twice.
- **Ports:** every port of the game moves by the same amount, so Valheim's query port stays one above the game port and Satisfactory's shared port stays shared. On a public server the old router rules are closed and the new ones opened by the same code that makes a server public. **To check on the homelab:** change a public server's port, confirm the router lists the new port, and join on it.
- **Not covered:** going back to an older version has no button; restore the backup from before the update.

## Dashboard charts and header (not yet seen on the real host)

- The small charts (CPU, network, players) come from a sample the panel takes every 20 seconds and keeps in memory for 15 minutes. After a restart they start empty and fill in; nothing is drawn for time the panel was not running.
- "peak N today" for players is saved in the panel's settings table (key `players-peak-today`), so it survives a restart. It resets at midnight in the panel's time zone (set `TZ`).
- The header line (host name, Docker version, uptime) comes from Docker's `info` call and `/proc/uptime`. Check that the host name is your machine's, not a container id.
- The "..." row menu is drawn on the page rather than inside the table. Check it on a phone and with the keyboard (Enter opens it, arrows move, Escape closes).

## Hide my IP through playit.gg (not yet run on real hardware)

Covered by tests against a fake playit.gg API and a fake Docker: the client's headers and body, both `rundata` shapes, tunnel planning (one per host port, TCP and UDP on one port merged), saving the key encrypted and never returning it, creating tunnels against an existing agent, the guided fallback when creation is refused, adopting a hand-made tunnel, the managed agent container (host networking, no privileged mode, only the key in its environment), and the two switches (Hide my IP on a public server keeps the router rules, the DNS record and the tunnels and shows both addresses; on a private server it opens nothing; changing access never touches the relay and turning Hide my IP off never touches the router or DNS; turning it off removes only the tunnels the panel made, so hand-made ones bring the same address back when it is turned on again; an unconfigured relay leaves the server as it was; servers stored as access "relay" are converted by the migration). The tests ran on Windows for this change; the backup and update tests need Linux `tar` and were not meaningful there, so CI is the real run.

Not run, and needs the maintainer's homelab and a playit.gg account:

- **Whether an agent secret key may create tunnels.** A forum post says agent keys are read-only. If playit.gg refuses, the panel falls back to listing the tunnels to create in the dashboard. Check which happens, and that the address then appears by itself within about 30 seconds.
- **The `/tunnels/create` body** was written from the agent's source, not from a recorded call.
- **The free-plan numbers** (about 4 TCP and 4 UDP tunnels) come from reviews, not from the account.
- **A UDP game through the relay.** Palworld joined by a friend using the relay address, including whether the server list or query port matters.
- **Follow-up for the setup dialog, the agent address default and faster tunnel pickup.** Tests cover `fix` and `localNote` in the relay info, the `refreshSoon` rules (stale only, one at a time, nothing without a key), and a hand-made tunnel with the exact name being adopted whatever its type. The web changes passed the type check but were not clicked through. A read-only look at the maintainer's host (`docker ps` and `docker logs` for the playit agent and the panel, over SSH) was attempted and refused by the permission check, so it was not done, and the cause of "Relay ready but the dialog still showed manual steps" is inferred from the code (a stale dialog snapshot and a relay answer refreshed only on a timer), not from the logs.
- **The address the agent uses to reach this machine** when the agent runs in another container (for example Dockhand): the saved address or `HOST_LAN_IP` must be reachable from that container.
- **Managed mode** (the panel runs `ghcr.io/playit-cloud/playit-agent:1.0.10`) on a host with no agent yet, and that it is removed when the last relay server leaves.
- That the direct path (router rules, Cloudflare) is untouched when a server is moved back from the relay to public.
