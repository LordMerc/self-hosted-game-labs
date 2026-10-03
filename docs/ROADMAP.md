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
- [x] Game servers page: server table, template row (deploy disabled)

Next:

- [ ] Docker driver: pull with progress, create labelled container, start, stop, restart, delete
- [ ] Deploy flow and readiness wait; Error state with Retry / Remove
- [ ] Log streaming (SSE)
- [ ] Connectivity providers: `manual` (rules + confirmation), then `upnp` (`upnpc`)
- [ ] Cloudflare: DDNS A record, per-server CNAME, `gamelabs:` ownership comments
- [ ] Public / Private toggle
- [ ] Deploy form generated from the template
- [ ] Real-world verification: friend connects from outside the LAN

## Later

2. **Stays working on its own**: reconcile loop, drift detection, honest reachability check
3. **UI to spec**: Network panel, server detail page, deploy wizard, conflict UX, Dragonwilds template
4. **Templates and care**: Minecraft, Valheim, Satisfactory, Terraria; backups and restore; scheduled restarts; update checks

Ideas outside the current scope (not committed): extra navigation sections from the concept art (Overview, Network, Backups, Logs) once there is a clear reason to split them from Game servers.
