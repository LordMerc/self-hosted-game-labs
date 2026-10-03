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

## Compose file (2026-10-03)

- First real deploy attempt by the maintainer, as a Dockhand "From Git" stack, failed with `Compose file not found: compose.yaml`: Dockhand looks for `compose.yaml` and the repo had `docker-compose.yml`. Fixed by renaming to `compose.yaml`.
- Also changed so a stack deploy needs no `.env` file: settings are passed through `environment:` with defaults, and data lives in a named volume instead of `./data`.
- `docker compose config` validates the file (with and without variables set); the server starts with the resulting empty-string values. The image build itself is still unrun.

## Image build fix (2026-10-03)

- Dockhand build failed at `RUN npm ci` (exit 1). Reproduced locally by running `npm ci` with no C toolchain on PATH, like `node:22-bookworm-slim`: `better-sqlite3` has a `binding.gyp` and no install script, so npm runs `node-gyp rebuild`, which needs Python and a compiler.
- Fix: `npm ci --ignore-scripts` (Dockerfile and CI). Verified with no toolchain on PATH: `better-sqlite3` and `argon2` load from their bundled prebuilds, `npm run build` passes, and all 62 tests pass.
- The Docker image build itself is still not run end to end (no Docker daemon in the sandbox).
