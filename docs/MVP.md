# What a working MVP still needs

**MVP definition:** the goal in [design.md](design.md): click *New server, Palworld*, and a few minutes later a friend on the internet connects, without anyone touching the router or DNS dashboard after first-time setup, and it keeps working after a router reboot or IP change. That is Milestones 1 and 2.

## Built and tested against fakes

Panel and auth, templates and port allocation, deploy / start / stop / restart / delete, live logs, Public / Private with manual or UPnP forwarding, Cloudflare DDNS and per-server DNS, reconcile loop (router reboot, deleted DNS, IP change, missing container). 62 automated tests plus a headless-browser run against the real server.

## Blocking the MVP

1. **Run it for real.** Nothing has touched a real Docker daemon, router or Cloudflare zone yet. This needs the maintainer's homelab: `docker compose up`, deploy Palworld, check `upnpc -l` or add the manual rule, `dig` the DNS name, and have a friend connect from outside. Expect fixes (image env names, `upnpc` output differences). Record results in [verification.md](verification.md).
2. **Verify the Palworld template** against the image's current docs (env names, ports, data path) and pin an image tag once a version works.
3. **Honest reachability check.** The UI currently says "Reachability untested, check from a phone on cellular data" for public servers and never claims a port is open. A real check needs an outside vantage point (a third-party service), which is a privacy and dependency choice for the maintainer.

## Not needed for the MVP, planned next

- Header stats (CPU, memory, storage, network, players online)
- Server detail page: config / env editor, console / RCON
- More templates (Minecraft, Valheim, Satisfactory, Terraria, Dragonwilds, Custom): each must be verified against its image before shipping
- Backups and restore, scheduled restarts, update checks
- Playwright smoke test in CI once the UI settles
