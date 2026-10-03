# Roadmap

Milestones follow [design.md](design.md) section 8. A milestone is done when its acceptance criteria are met **and** the evidence is recorded in [verification.md](verification.md).

## Milestone 1: Play Palworld with a friend

Done (this scaffold):

- [x] Project skeleton: TypeScript, Fastify API, React + Vite shell, Dockerfile, compose file, CI
- [x] SQLite with Drizzle migrations; `/api/health`
- [x] Admin password (argon2id), signed session cookie, rate-limited login
- [x] Template schema, loader and validator (rejects unknown or unsafe keys)
- [x] Port allocator (conflict-free, contiguous blocks, host-port awareness) and slug helper
- [x] Palworld template
- [x] Dragonwilds template (not yet run on real hardware, see verification.md)
- [x] Game servers page: server table, template row (deploy disabled)

Also done (built against fakes, see verification.md for what is unproven):

- [x] Docker driver (pull, create labelled container, start, stop, restart, remove, log streaming) and the deploy flow with Error + Retry
- [x] Connectivity providers: `manual` (rules + confirmation) and `upnp` (`upnpc`, only touches `gamelabs:` mappings)
- [x] Cloudflare: DDNS A record and per-server CNAME, DNS-only, only touches `gamelabs:`-commented records
- [x] Public / Private toggle, delete (data kept unless the name is typed), secrets hidden until revealed
- [x] Deploy form generated from the template; Network panel; log viewer
- [x] Reconcile loop (from Milestone 2): startup + every 5 minutes. Recreates missing containers, re-opens mappings, restores DNS, removes stale tagged DNS, updates DDNS on IP change

Still open for Milestone 1:

- [x] Real-world verification on a Docker host: image builds, Palworld deploys, UPnP rule works, DNS resolves, a friend connected from outside the LAN (2026-10-03, maintainer's homelab)

## Later

2. **Stays working on its own**: reconcile loop and honest reachability check (TCP from outside via check-host.net, UDP shown as router-forwarded) are done; the check still needs a real-hardware run
3. **UI to spec**: Network panel, server detail page, deploy wizard, conflict UX, Dragonwilds template
4. **Templates and care**: Minecraft, Valheim, Satisfactory, Terraria and a custom image option (done); backups and restore (done); scheduled restarts; update checks; per-server CPU and memory limits (done)

Ideas outside the current scope (not committed): extra navigation sections from the concept art (Overview, Network, Backups, Logs) once there is a clear reason to split them from Game servers.
