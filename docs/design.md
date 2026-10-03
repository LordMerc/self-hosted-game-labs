> Original design spec, written around the maintainer's own homelab (Deco router, Cloudflare, `lordmerc.dev`). Treat the specifics as examples; the panel itself is configurable. Milestone status lives in [ROADMAP.md](ROADMAP.md).

# Project: Homelab Game Panel

A self-hosted web app that deploys and manages game servers as Docker containers on a homelab and handles public connectivity (router port forwarding, DNS, dynamic IP), so the owner never opens the Deco app or the Cloudflare dashboard after first-time setup.

**Goal:** Click "New server → Palworld". A few minutes later, friends connect over the internet with nothing to install and no manual networking.

---

## 1. Environment (fixed constraints)

| Item | Value |
|---|---|
| Host | Old PC running Ubuntu Linux, Docker installed |
| Existing container UI | Dockhand. The panel coexists with it; it does not replace it |
| Router | TP-Link Deco mesh. Public IPv4 on WAN, no CGNAT, no double NAT |
| Domain | `lordmerc.dev` on Cloudflare (DNS only; the panel is not published through the Tunnel) |
| Admin access | LAN at home, Tailscale when away. Friends never join the tailnet |
| Players | Connect directly over the internet |

**Out of scope:** VPS/relay, Tailscale Funnel, playit.gg, friend tailnet invites, multi-host, paid services, a host shell (Dockhand already has one).

---

## 2. Architecture

One container, `gamepanel`, running on the homelab:

```
Browser (LAN or Tailscale) ──password login──► gamepanel (network_mode: host)
                                          ├─ Docker socket      → create/manage game containers
                                          ├─ Connectivity       → upnp (Deco) | manual
                                          ├─ Cloudflare API     → DDNS A record + per-game CNAMEs
                                          └─ SQLite (/data)     → servers, ports, settings, events
```

- `network_mode: host` is required: UPnP SSDP discovery does not cross the Docker bridge.
- The dashboard is never port forwarded and is not published through the Cloudflare Tunnel. It is reachable only on the LAN and over Tailscale.
- Auth is a single admin password (argon2 hash in `/data`, set on first run) with a signed session cookie and rate-limited login. Required even on the LAN, because the panel holds the Docker socket.
- Later option, not in scope: publish through Cloudflare Tunnel + Access for browsers without Tailscale.

### Stack

- Node 22 and TypeScript. Fastify API and a React + Vite frontend served by the same process.
- SQLite via better-sqlite3 and Drizzle. Base image `node:22-bookworm-slim` (prebuilt native binaries).
- `dockerode` for Docker.
- `miniupnpc` (`upnpc` CLI) in the image, wrapped in a typed module.
- Cloudflare REST API v4 via `fetch`. Token limited to Zone:DNS:Edit on `lordmerc.dev`.
- Vitest for unit tests. Playwright only once the UI is stable (Milestone 3).

### Deployment compose

```yaml
services:
  gamepanel:
    build: .
    container_name: gamepanel
    network_mode: host
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
      - /srv/gameservers:/srv/gameservers
    environment:
      - PANEL_PORT=8090
      - CF_API_TOKEN=${CF_API_TOKEN}
      - CF_ZONE=lordmerc.dev
      - SESSION_SECRET=${SESSION_SECRET}
      - PUBLIC_HOST=play.lordmerc.dev
      - HOST_LAN_IP=${HOST_LAN_IP}
      - CONNECTIVITY=upnp          # upnp | manual
```

---

## 3. Core concepts

### Game templates (`templates/*.yaml`)

A template declares image, ports, env (including required user inputs), data paths, readiness, and how players join.

```yaml
id: dragonwilds
name: "RuneScape: Dragonwilds"
image: ghcr.io/runescape/rsdw-dedicated:latest
maxPlayers: 6                 # engine cap
join:
  method: server-browser      # direct | server-browser
  instructions: "Open the in-game server browser and search for the server name."
ports:
  - name: game
    default: 7777
    protocol: udp
    env: RSDW_PORT            # server must be told its port
    mustMatchHost: true       # host port == container port == env value
    query: none               # none | a2s | minecraft  (used by the reachability check)
env:
  RSDW_SERVER_NAME:    { label: Server name, default: "Dragonwilds Server" }
  RSDW_OWNER_ID:       { label: Your Dragonwilds Player ID, required: true, help: "In-game Settings → bottom of menu" }
  RSDW_ADMIN_PASSWORD: { label: Admin password, secret: true, generate: true }
data:
  - { containerPath: /home/steam/rsdw-dedicated }   # bind-mounted from /srv/gameservers/<slug>/
readiness:
  type: port-listening        # default; templates may override with a log regex or healthcheck
```

**Starter templates.** Verify image, ports, and env names against current docs before shipping each one.

| Template | Image | Default ports | Join |
|---|---|---|---|
| Palworld | `thijsvanloef/palworld-server-docker` | 8211/udp (+27015/udp query) | direct |
| Dragonwilds | `ghcr.io/runescape/rsdw-dedicated` | 7777/udp (+8888/udp beacon) | server-browser |
| Minecraft Java | `itzg/minecraft-server` | 25565/tcp | direct |
| Valheim | `lloesche/valheim-server` | 2456–2457/udp | direct |
| Satisfactory | `wolveix/satisfactory-server` | 7777/udp+tcp, 8888/tcp | direct |
| Terraria | maintained tModLoader image (choose) | 7777/tcp | direct |
| Custom | user-supplied image and ports | — | user-specified |

### Port allocation rules

- Always map host port = container port, and pass the port through the template's `env` when declared.
- On create, start from the template default and increment until free across both the database and the host (`ss -lun` / `ss -ltn`).
- Hard-block duplicate (host port, protocol) pairs. Dragonwilds, Satisfactory, and Terraria all default to 7777.
- Multi-port games allocate one contiguous block (Valheim 2456–2457).

### Connectivity providers

Interface: `ensureOpen(port, proto, lanIp)`, `ensureClosed(...)`, `list()`, `externalIp()`.

- **upnp:** wraps `upnpc`. Every mapping description is prefixed `gamepanel:<slug>` so the panel recognizes its own mappings and never removes others.
- **manual:** stores the rules the user must add in the Deco app, shows them in the UI with a "I've added this" confirmation, and treats confirmed rules as open. `externalIp()` falls back to an HTTPS IP echo.

The provider is a global setting, and the UI shows which one is active. Switching from upnp to manual keeps existing state and shows outstanding rules.

### Access modes (per server)

- **Private:** container runs; LAN and Tailscale only; no mappings, no DNS record.
- **Public:** connectivity ensured for every port, plus a CNAME `<slug>.lordmerc.dev → play.lordmerc.dev` (DNS only, never proxied). Templates with `join: server-browser` still get the record but the UI shows the join instructions instead of an address.

### DNS record ownership

Every record the panel creates carries the Cloudflare record `comment` `gamepanel:<slug>` (or `gamepanel:ddns` for the A record). Reconcile and delete only ever touch records with a `gamepanel:` comment.

### Status vocabulary

**Online / Paused / Offline**, plus transient **Deploying / Updating / Error**.

### Reachability check (honest version)

- TCP port: external TCP connect via a documented third-party checker API.
- UDP port with `query: a2s` or `query: minecraft`: protocol-level query from an external vantage point if one is configured; otherwise skipped.
- Anything else: **Untested**, with the instruction "verify from a phone on cellular data".
The UI never shows "Open" for a port it could not actually test.

---

## 4. Flows

### Deploy a new server

1. User picks a template and fills the generated form.
2. Allocate ports and a slug (`palworld`, `palworld-2`).
3. Create `/srv/gameservers/<slug>/`, pull the image (stream progress), create the container with labels `gamepanel.managed=true`, `gamepanel.id=<id>`, `gamepanel.slug=<slug>`, and `restart: unless-stopped`.
4. Start it and wait for readiness.
5. If Public: ensure connectivity, create the CNAME, run the reachability check.
6. Persist, emit events, show the connect address or the join instructions.

Every step is idempotent and logged. A failure leaves a clear Error state with Retry and Remove, and no orphaned mappings or DNS records.

### Reconcile loop (every 5 minutes and on startup)

- Database vs Docker: recreate missing containers; flag drift; never touch containers without `gamepanel.managed`.
- Connectivity: re-ensure mappings for Public servers (the Deco wipes them on reboot; leases expire).
- DNS: ensure each Public server's tagged CNAME exists; remove tagged CNAMEs for deleted or Private servers.
- DDNS: get the public IP (UPnP `externalIp()`, else HTTPS echo) and update `play.lordmerc.dev` when it changes.

### Toggle Public / Private

Applies or removes connectivity and the CNAME immediately, then re-runs the reachability check.

### Delete

Stop, remove connectivity and DNS, remove the container. Data in `/srv/gameservers/<slug>/` is kept by default; "Delete world data" requires typing the server name.

---

## 5. UI

Keep the concept's layout: left nav, header stats (CPU, Memory, Storage, Network, Players online), server table, one-click template row.

**Changes from the mockup**

- Remove: Funnel toggle, "Invite a friend to the tailnet", "Shared · N" options, Host shell.
- Server table:
  - "Tailscale address" → **Connect**: public address first (`pal.lordmerc.dev:8211`), LAN address below in muted mono; for `server-browser` games, show "Find in server browser" with a tooltip.
  - Ports with protocols per server.
  - Per-row **Private / Public** pill.
- Right panel → **Network**:
  - Public IP, DDNS status, last update
  - Connectivity provider (UPnP reachable / Manual) and the active mappings or outstanding manual rules
  - Reachability per server: OK / Closed / Untested
  - Tailscale shown as "Admin access" status only, no controls
- Server detail page: live logs (SSE), console/RCON where supported, config and env editor (apply = recreate), ports, backups, danger zone.
- Port conflict: inline error with a suggested free port.

**Design direction:** clean typography, flat surfaces, soft navy gradients, restrained cyan accents, generous whitespace, Linear/Vercel-level polish. No neon, glow, grids, or sci-fi fonts.

---

## 6. Security

- The Docker socket gives root-equivalent control of the host. The panel is LAN/Tailscale only, is never port forwarded or tunneled, and always requires the admin password.
- Cloudflare token scoped to DNS edit on the zone, stored in env, never in the database or logs.
- Only ports owned by managed servers are ever mapped; only `gamepanel:`-tagged mappings and DNS records are ever removed.
- Secrets (admin and RCON passwords) are redacted in logs and the API, revealed only on click.
- Custom templates cannot use `privileged`, host networking, or bind mounts outside `/srv/gameservers/`.

---

## 7. Persistence and backups

- SQLite at `/data/panel.db`, migrated via Drizzle on startup.
- World data at `/srv/gameservers/<slug>/` (bind mounts).
- Backups (Milestone 4): per-server schedule, daily by default, keep 7, tar of the data directory to `/data/backups/<slug>/`, server paused or stopped first when the template requires it. One-click restore.
- Optional later: scheduled restarts; auto-update (pull, compare digest, recreate during an empty-server window).

---

## 8. Milestones

Each milestone ends with its acceptance criteria met **and** a verification log in `docs/verification.md`: commands run, results, and anything that could not be run. Environment failures are recorded separately from code failures. A milestone is not done because code exists.

### Milestone 1 – Play Palworld with a friend (MVP)
- Skeleton: Dockerfile, compose, Fastify + React shell, SQLite migrations, `/api/health`, admin password login.
- Template loader and validator, port allocator, Palworld template.
- Deploy, start, stop, restart, delete, log streaming.
- Connectivity providers: `manual` first (it's the simplest), then `upnp`.
- Cloudflare: DDNS A record and CNAME create/delete with `gamepanel:` comments.
- Public/Private toggle. Minimal table UI.
- **AC**
  - `docker compose up` serves the UI; `/api/health` ok; the database is created.
  - Deploying Palworld creates a labeled container and data directory and reaches Online.
  - With `CONNECTIVITY=upnp`, the mapping appears in `upnpc -l`; toggling to Private removes only gamepanel mappings; a clear error appears when UPnP is off on the Deco.
  - With `CONNECTIVITY=manual`, the UI shows the exact Deco rule and tracks confirmation.
  - `dig pal.lordmerc.dev` resolves to the public IP; records are never proxied.
  - A friend connects from outside the LAN. Recorded in `docs/verification.md`.
  - Unit tests cover the allocator, template validation, and DNS record tagging.

### Milestone 2 – Stays working on its own
- Reconcile loop and drift detection. Reachability check (honest version).
- **AC**
  - After clearing UPnP mappings (simulated Deco reboot), mappings return within one cycle.
  - Manually deleting a tagged CNAME gets it restored; untagged records are never touched.
  - Changing the stored public IP triggers a DDNS update.
  - UDP ports with no query protocol show Untested, never Open.

### Milestone 3 – UI to spec
- Server table, Network panel, detail page, deploy wizard, conflict UX.
- Dragonwilds template (server-browser join) to prove the join-method UI.
- **AC**
  - Playwright smoke test: deploy → Online → Public → copy or instructions → Private → delete.
  - Two 7777 templates deployed together get distinct ports.

### Milestone 4 – Templates and care
- Minecraft, Valheim, Satisfactory, Terraria verified end to end.
- Backups and restore, scheduled restarts, update check, secret redaction audit.
- **AC**
  - Each template deploys and a real client connects from outside the LAN; results recorded.
  - A restore brings back a world.
  - Secrets never appear in `/api` responses or logs.

---

## 9. One-time manual setup (README)

1. Deco app → More → Advanced → NAT Forwarding → **UPnP: On** (skip if using `manual`).
2. Deco app → More → Advanced → **Address Reservation** for the homelab server.
3. Cloudflare → API Tokens → **Zone:DNS:Edit** on `lordmerc.dev`.
4. Fill in `.env`, run `docker compose up -d`, open `http://<server-lan-ip>:8090`, and set the admin password on first run.
5. Away from home, reach the same address over Tailscale.

---

## 10. Known caveats

- Players see the home public IP; only game ports are ever exposed.
- At home, connect to the LAN address; the public address may fail inside the LAN (NAT hairpinning).
- Dragonwilds needs the owner's in-game Player ID, caps at 6 players, joins via the in-game browser, and its server version must match clients.
- UPnP lets any LAN device open ports. Accepted trade-off; `manual` mode exists for anyone who wants it off.
- Images under `thijsvanloef/`, `ferment9348/`, `lloesche/`, `wolveix/` are community-maintained. Pin tags once a working version is confirmed.
