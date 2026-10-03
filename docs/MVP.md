# What a working MVP still needs

**MVP definition:** the goal in [design.md](design.md): click *New server, Palworld*, and a few minutes later a friend on the internet connects, without anyone touching the router or DNS dashboard after first-time setup, and it keeps working after a router reboot or IP change. That is Milestones 1 and 2.

## Built and tested against fakes

Panel and auth, templates and port allocation, deploy / start / stop / restart / delete, live logs, Public / Private with manual or UPnP forwarding, Cloudflare DDNS and per-server DNS, reconcile loop (router reboot, deleted DNS, IP change, missing container). 62 automated tests plus a headless-browser run against the real server.

## Blocking the MVP

1. **A friend connecting from outside.** Docker, UPnP on a Deco router and Cloudflare have now run for real on the maintainer's homelab and a LAN join works (see [verification.md](verification.md)). The last step, a join from the internet, is still to be confirmed.
2. **Verify the Palworld template** against the image's current docs (env names, ports, data path) and pin an image tag once a version works.
3. **Honest reachability check.** The UI currently says "Reachability untested, check from a phone on cellular data" for public servers and never claims a port is open. A real check needs an outside vantage point (a third-party service), which is a privacy and dependency choice for the maintainer.

## Not needed for the MVP, planned next

- Header stats: CPU, memory, storage and network are done, plus per-server CPU and memory. Live player counts work for games that answer the Steam A2S query (Palworld, unverified on a real server); other games need their own query
- Server page: config editor and console are done (open a server's name); ports editing is not
- Templates: Palworld, Dragonwilds, Minecraft (Java), Valheim, Satisfactory, Terraria and a Custom Docker image option are in. More games each need verifying against their image first (see verification.md for what was and was not run)
- Backups: manual backup, restore (with a safety copy) and delete are done. Scheduled (automatic) backups are done too. Scheduled restarts and update checks are not
- Browser smoke test: done (`e2e/`, runs in CI). It uses a fake Docker, so it checks the UI and API together, not the games
