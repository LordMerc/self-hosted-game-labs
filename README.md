# Self Hosted Game Labs

An open-source, self-hosted control panel for running game servers on your own hardware. Pick a game, click deploy, and friends can join over the internet, with the panel handling containers, ports, and DNS so you do not have to touch your router or DNS dashboard after first-time setup.

> **Status: early development.** Deploy, start/stop, logs, Public/Private (manual or UPnP port forwarding) and Cloudflare DNS are built and tested against fakes, but have not yet been run against a real Docker host, router and Cloudflare zone. See [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/verification.md](docs/verification.md).

## What it does (target)

- One-click Docker templates for popular games (Palworld first; Minecraft, Valheim, Satisfactory, Terraria, Dragonwilds, and a custom image option to follow).
- Start, stop, restart, delete and stream logs for every server from one page.
- Per-server **Private / Public** switch. Public opens the game ports on your router (UPnP, or a manual checklist) and creates a DNS name for the server.
- Dynamic DNS and an honest reachability check that says "Untested" rather than guessing.

The design is in [docs/design.md](docs/design.md). The concept art the UI is based on has a server list, status, ports, access toggles and a network panel. For now the navigation is just **Game servers**.

## Stack

Node 22 + TypeScript, Fastify API, React + Vite frontend served by the same process, SQLite (better-sqlite3 + Drizzle), `dockerode`, Vitest.

## Quick start

```bash
cp .env.example .env     # set HOST_LAN_IP, PUBLIC_HOST, and the Cloudflare values if you want DNS
docker compose up -d --build
```

Open `http://<server-lan-ip>:8090` and set the admin password on first run.

**Do this before exposing anything:** the panel has access to the Docker socket, which is root-equivalent control of the host. Keep it on your LAN or behind a VPN such as Tailscale. Never port forward the panel itself. The first-run password screen is open to anyone who can reach the port until you complete it, so do it right after starting the container.

## Development

```bash
npm ci
npm test               # unit and API tests
npm run typecheck
npm run dev:server     # needs SESSION_SECRET (32+ chars) and DATA_DIR, e.g. DATA_DIR=./data
npm run dev:web        # Vite dev server, proxies /api to :8090
```

Game templates live in `templates/*.yaml` and are validated on startup against `src/shared/template.ts`. Unknown keys are rejected, so a template cannot request privileged mode, host networking or arbitrary bind mounts.

## License

MIT
