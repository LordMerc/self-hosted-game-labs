# Self Hosted Game Labs

An open-source, self-hosted control panel for running game servers on your own hardware. Pick a game, click deploy, and friends can join over the internet, with the panel handling containers, ports, and DNS so you do not have to touch your router or DNS dashboard after first-time setup.

> **Status: early development.** Deploy, start/stop, logs, Public/Private (manual or UPnP port forwarding) and Cloudflare DNS are built and tested against fakes, but have not yet been run against a real Docker host, router and Cloudflare zone. See [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/verification.md](docs/verification.md).

## What it does (target)

- One-click Docker templates for popular games (Palworld, RuneScape: Dragonwilds, Minecraft (Java), Valheim, Satisfactory and Terraria), plus a Custom Docker image option for anything else.
- Start, stop, restart, delete and stream logs for every server from one page.
- Per-server **Private / Public** switch. Public opens the game ports on your router (UPnP, or a manual checklist) and creates a DNS name for the server.
- Dynamic DNS and an honest reachability check. Press Run in the Network panel to test a public server's TCP ports from outside; UDP games cannot be tested that way, so the panel shows whether the router forwards the port, and never says "open" without a real test. The test sends your public IP and port to a third-party checker (check-host.net) only when you press Run; set `PORT_CHECK=off` to remove it.

The design is in [docs/design.md](docs/design.md). The concept art the UI is based on has a server list, status, ports, access toggles and a network panel. For now the navigation is just **Game servers**.

## Stack

Node 22 + TypeScript, Fastify API, React + Vite frontend served by the same process, SQLite (better-sqlite3 + Drizzle), `dockerode`, Vitest.

## Quick start

```bash
cp .env.example .env     # optional: set HOST_LAN_IP, PUBLIC_HOST, and the Cloudflare values if you want DNS
docker compose up -d --build
```

The compose file is `compose.yaml`, so Git-based stack deploys (Dockhand, Portainer, and similar) work too. Set the same variables from `.env.example` as environment variables on the stack instead of using a `.env` file.

Open `http://<server-lan-ip>:8090` and set the admin password on first run.

**Do this before exposing anything:** the panel has access to the Docker socket, which is root-equivalent control of the host. Keep it on your LAN or behind a VPN such as Tailscale. Never port forward the panel itself. The first-run password screen is open to anyone who can reach the port until you complete it, so do it right after starting the container.

### Run the published image instead of building

Every commit on `main` is published as `ghcr.io/lordmerc/self-hosted-game-labs:latest` (amd64 and arm64), and releases as `:1.0.0`-style version tags. To run it without building anything:

```bash
curl -O https://raw.githubusercontent.com/LordMerc/self-hosted-game-labs/main/compose.image.yaml
docker compose -f compose.image.yaml up -d
```

It needs the same things as `compose.yaml`: the Docker socket mount, the `gamelabs-data` volume for the panel's own data, and `GAME_DATA_DIR` (default `/srv/gameservers`, and the host path must be the same inside the container). The optional variables (`PANEL_PORT`, `HOST_LAN_IP`, `CONNECTIVITY`, `BACKUP_KEEP`, `PORT_CHECK`, ...) are listed in `.env.example`. Set `IMAGE_TAG=1.0.0` to pin a release instead of following `latest`.

## Trying changes before a release

You can run a second copy of the panel next to your real one to preview a branch before it reaches everyone. Give the copy its own name with `INSTANCE`, so the two panels never touch each other's game servers, router rules or DNS records, and give it its own port and game data folder.

With Dockhand (or any Git-based stack deploy), create a second stack, for example `gamelabs-beta`, from the same repository:

- **Branch:** the branch you want to try (a feature branch, or `beta`). Compose file: `compose.yaml` (builds from source on your machine).
- **Environment variables:** `INSTANCE=beta`, `PANEL_PORT=8091`, and `GAME_DATA_DIR` set to a folder the real panel does not use (for example `/srv/gameservers-beta`).
- Keep the stack name different from the real one, so it gets its own `gamelabs-data` volume and its own admin password.

If you would rather test the prebuilt preview image, pushes to the `beta` branch publish `ghcr.io/lordmerc/self-hosted-game-labs:beta`. Use `compose.image.yaml` with `IMAGE_TAG=beta` and the same variables.

Things to know:

- The beta panel's containers are named `gl-beta-<name>`; the real panel keeps `gl-<name>`. The real panel ignores everything tagged `beta`, and the reverse.
- Game ports are shared by the whole machine. To test deploying Palworld in the beta panel, stop the real Palworld server first (or test a game you are not running), otherwise the port is already taken.
- Leave router automation and Cloudflare off in the beta panel (`CONNECTIVITY` defaults to `manual`), and use different server names, so it cannot change your real DNS or router rules.
- Promote a tested change the normal way: open a pull request into `main`, merge it, and (optionally) tag a release.

## Domain names (optional)

Without a domain, public servers are reached by your IP address. To get names like `palworld.example.com`, open **Settings** in the panel, paste a Cloudflare API token and pick your domain. The panel lists the steps. In short: create a custom token at Cloudflare with **Zone · Zone · Read** and **Zone · DNS · Edit**, limited to your domain. The panel creates DNS-only records (never proxied) and keeps them pointed at your current IP, and it only ever changes records it created. You can instead set `CF_API_TOKEN`, `CF_ZONE` and `PUBLIC_HOST` as environment variables, which override the Settings page.

## Where game data is stored

Game servers keep their files (including world saves) under `GAME_DATA_DIR`, `/srv/gameservers` by default, one folder per server. Set `GAME_DATA_DIR` to a path on another drive (for example `/mnt/games`) to keep them off your system disk. The drive must be mounted before the panel starts, or Docker will quietly create the folder on the system disk. Changing it affects servers deployed afterwards; existing servers keep their current folder until they are redeployed (delete the server, which keeps its data, move the folder, then deploy again with the same name). Docker's own image downloads live in Docker's data root, which is a Docker daemon setting rather than something the panel controls.

## Development

```bash
npm ci
npm test               # unit and API tests
npm run build:web && npm run test:e2e   # browser smoke test (needs Chromium: npx playwright install chromium)
npm run typecheck
npm run dev:server     # needs SESSION_SECRET (32+ chars) and DATA_DIR, e.g. DATA_DIR=./data
npm run dev:web        # Vite dev server, proxies /api to :8090
```

Game templates live in `templates/*.yaml` and are validated on startup against `src/shared/template.ts`. Unknown keys are rejected, so a template cannot request privileged mode, host networking or arbitrary bind mounts.

## License

MIT

## Contributing

Changes go through pull requests so CI can check them; see [CONTRIBUTING.md](CONTRIBUTING.md).
