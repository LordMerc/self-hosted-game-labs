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
