# What a working MVP still needs

**MVP definition:** the goal in [design.md](design.md): click *New server, Palworld*, and a few minutes later a friend on the internet connects, without anyone touching the router or DNS dashboard after first-time setup, and it keeps working after a router reboot or IP change. That is Milestones 1 and 2.

## Built and tested against fakes

Panel and auth, templates and port allocation, deploy / start / stop / restart / delete, live logs, Public / Private with manual or UPnP forwarding, Cloudflare DDNS and per-server DNS, reconcile loop (router reboot, deleted DNS, IP change, missing container). 62 automated tests plus a headless-browser run against the real server.

## Blocking the MVP

1. ~~**A friend connecting from outside.**~~ Verified 2026-10-03: a friend joined the maintainer's Palworld from the internet at `palworld.<domain>:8211`, through UPnP and the Cloudflare DNS record the panel made. Docker, UPnP on a Deco router and Cloudflare all ran for real (see [verification.md](verification.md)). The MVP goal is met; the items below are what is left to make it solid.
2. **Verify the Palworld template** against the image's current docs (env names, ports, data path) and pin an image tag once a version works. Done: pinned to `v2.8.0`, the version that was `latest` when the first world ran (checked against Docker Hub on 2026-10-03).
3. ~~**Honest reachability check.**~~ Built (the maintainer agreed to a third-party checker on 2026-10-03). **Run** in the Network panel asks check-host.net to connect to each public server's TCP ports from a few locations; UDP ports (Palworld, Dragonwilds, Valheim) cannot be tested from outside, so they show "Router forwards the port" from the router's mapping list. It never says "open" without a real connection. `PORT_CHECK=off` removes it. The provider's API has not been exercised from the build sandbox, see [verification.md](verification.md).

## Not needed for the MVP, planned next

- Header stats: CPU, memory, storage and network are done, plus per-server CPU and memory. Live player counts work for Valheim (Steam A2S query), Minecraft and Palworld (the game's REST API, because its A2S port never answers); Dragonwilds, Satisfactory and Terraria have no query and say so
- Server page: config editor and console are done (open a server's name); ports editing is done too
- Templates: Palworld, Dragonwilds, Minecraft (Java), Valheim, Satisfactory, Terraria and a Custom Docker image option are in. More games each need verifying against their image first (see verification.md for what was and was not run)
- Backups: manual backup, restore (with a safety copy) and delete are done. Scheduled (automatic) backups are done too. Daily restarts (with an in-game warning where the game allows), update checks, applying updates after a backup and automatic updates are built, with Palworld pinned to `v2.8.0`; none of them has run on the real homelab yet, see [verification.md](verification.md)
- Browser smoke test: done (`e2e/`, runs in CI). It uses a fake Docker, so it checks the UI and API together, not the games
