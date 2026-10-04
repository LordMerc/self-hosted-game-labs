# Hide my IP with playit.gg

How the "Hide my IP" relay works, and what we learned about playit.gg while building it. Anything marked **unverified** was read from source code or secondary write-ups and has not been run against a real account. [verification.md](verification.md) lists what still needs the maintainer's hardware.

## Why a relay

The Cloudflare integration only writes a DNS record, so players still resolve to the home IP. A relay gives players an address that belongs to the relay provider. The home connection makes an outbound connection to the relay, so no router rule is needed and friends install nothing.

"Hide my IP" is a switch of its own (`servers.hide_ip`), not a third access value. Access stays `private` or `public`, and the relay is added on top:

- **Private + Hide my IP:** no router mappings, no DNS record and no port check. Players use the relay address; the LAN address still works at home.
- **Public + Hide my IP:** the router rules, the Cloudflare record and the port checks stay exactly as they are, and the tunnels are kept too. The Connect dialog gives the relay address "for strangers" and the Cloudflare name "for friends".
- Making a server public or private never touches its tunnels, and turning Hide my IP off or on never touches its router rules or DNS record.

Servers stored by the earlier version with `access = relay` are converted on startup (migration `0003_hide_ip`): `access` becomes `private` and `hide_ip` becomes true. The API still accepts `access: "relay"` as that same pair, and `PUT /api/servers/:id/hide-ip` with `{ "on": true | false }` is the switch.

Turning Hide my IP off removes only the tunnels the panel created. Tunnels you added by hand stay in playit.gg, so turning it back on finds them again by name and brings the same address back.

## The agent

- Image: `ghcr.io/playit-cloud/playit-agent` (also `playitcloud/playit` on Docker Hub). The tag `1.0.10` exists on ghcr (checked against the registry's manifest endpoint on 2026-10-03; `v1.0.10` does not). The panel pins `1.0.10` so an upstream release cannot change behaviour under users. `latest` exists, and 1.0.12 is only a pre-release.
- Run command from the README: `docker run --rm -it --net=host -e SECRET_KEY=<secret key> ghcr.io/playit-cloud/playit-agent:latest`. https://github.com/playit-cloud/playit-agent (README)
- The entrypoint runs `playitd --secret "$SECRET_KEY" --platform-docker`, so `SECRET_KEY` is the only required setting. https://github.com/playit-cloud/playit-agent (`docker/entrypoint.sh`)
- Host networking is the recommended mode. A tunnel's "local address" is then `127.0.0.1:<port>` and reaches a game port Docker published on the host. No privileged mode and no extra capabilities are needed.
- BSD-2-Clause licence, compatible with this project being open source.
- The secret key is created by the user in the playit.gg dashboard when adding an agent: https://playit.gg/account/setup/wizard/new-account/docker/docker-name

### Two ways to run it

1. **An agent you already run (the usual case, and the default).** Many people already have one, for example as a container managed by Dockhand or Portainer. Game Labs only needs its secret key. Tunnels then point at the address the agent uses to reach this machine: the value saved under Settings, otherwise `HOST_LAN_IP`. (If the agent runs on this same host with host networking, that is the LAN address or `127.0.0.1`.)
2. **Game Labs runs the agent ("managed").** Only offered when the person has none. The panel starts `gl-<instance>-playit` from the pinned image with `SECRET_KEY`, host networking and no privileged mode, only while at least one server uses the relay, and removes it when the last one leaves. The `INSTANCE` prefix keeps a beta panel's agent apart from the real one.

## The API

Read from the agent's own API client: https://github.com/playit-cloud/playit-agent (`packages/api_client/src/api.rs`, `http_client.rs`).

- Base URL `https://api.playit.gg`. Every call is `POST` with a JSON body and the header `Authorization: Agent-Key <secret>`.
- Responses are `{"status":"success","data":...}`, `{"status":"fail","data":...}` for a rejected request, or `{"status":"error","data":{"type":"auth","message":"InvalidAgentKey"}}` for a bad key.
- `/agents/rundata` returns the agent id and its tunnels. Two shapes exist and the panel reads both:
  - older: `assigned_domain` (or `custom_domain`) plus `port: {from, to}`; the address is `domain:port.from`;
  - newer: a ready-made `display_address` and `port_type`.
  A changed field name means "address not known yet", never a crash.
- `/tunnels/create` body used by the panel: `{name, tunnel_type: null, port_type: "tcp"|"udp"|"both", port_count: 1, origin: {type: "agent", data: {agent_id, local_ip, local_port}}, enabled: true, alloc: null, firewall_id: null, proxy_protocol: null}`. `/tunnels/delete` takes `{tunnel_id}`.

### Can the panel create tunnels by API?

**Unverified, and possibly not with an agent key.** A playit.gg forum answer says agent keys are read-only and that account-level API keys are not offered: https://discuss.playit.gg/t/account-level-api-key/5704. The auth error enum includes `NotAllowedWithReadOnly`, `AgentNotSelfManaged` and `SelfManagedAgentCanOnlyAffectSelf`, which fits that.

So the panel tries once, and if playit.gg refuses it stops asking (until the settings change) and falls back to **guided mode**: the "How to connect" dialog and the server page list each tunnel to create in the playit.gg dashboard (type, local address, local port), and the panel polls `/agents/rundata` until the address appears. A tunnel the person made by hand is adopted when its name is exactly `gl-<server>-<port>` (the tunnel type is ignored), or, for a tunnel not named `gl-*`, when it forwards the same local port.

The dialog opens by itself when Hide my IP is turned on and tunnels are missing. It walks through playit.gg's "Add Tunnel" form field by field, one card per tunnel with copy buttons, and links to the Tunnels page. It reads the live server list rather than a snapshot, so the address appears in it without reopening it. When all tunnels exist it shows the relay address as the one to share, with the home address labelled "At home only".

**How fast a new tunnel is noticed.** The panel remembers what playit.gg last said. A timer refreshes that about every half minute while a server uses the relay, and each time the server list is fetched it also refreshes in the background if a relay server is still missing a tunnel and the answer is older than 4 seconds (60 seconds once all are there). So a tunnel added by hand shows up within a few seconds while the dialog or Servers page is open.

**The agent's address for this machine.** A tunnel's local address must be one the agent can reach. `127.0.0.1` is right only when the agent shares this machine's network. An agent in its own Docker container (Dockhand, Portainer) would reach itself, and `172.17.x.x` is Docker's internal network, which has no published ports. So Settings defaults it to `HOST_LAN_IP`, warns when it is loopback or `172.17.x.x`, and offers a button to use the home network address.

A claim flow (`/claim/setup`, `/claim/exchange`) exists in the client but was not tried. It could replace pasting a key in a later version.

## Why not Cloudflare

Cloudflare's proxy carries only web traffic on the free plan, so it cannot front a game port. Cloudflare Tunnel can carry other traffic, but each player would need Cloudflare's WARP app. Spectrum, which proxies TCP and UDP, is an Enterprise product. playit.gg is free and the player installs nothing. The README says the same in two sentences.

## One tunnel per host port

The panel plans one tunnel per host port named `gl-<server>-<port>`. A port used for both TCP and UDP shares a single `both` tunnel, which keeps a server inside the free plan. The address shown to players is the first (game) port's.

## Free tier

From playit.gg's own pages, with the numbers taken from secondary reviews and **not confirmed against a live account**:

- Pricing and premium features: https://playit.gg/pricing and https://playit.gg/support/playit-premium/
- About 4 TCP and 4 UDP tunnels on the free plan. Global anycast, no region choice. No bandwidth cap is stated.
- Custom domains, `.playit.plus` names and regional tunnels need premium (about $3 a month). This is why the relay address is shown beside the Cloudflare name rather than replacing it: a CNAME cannot be pointed at a free address and keep the player's port.
- Secondary write-ups: https://blog.gedas.dev/playitgg/ and the Pinggy and dev.to reviews.

The panel counts the tunnels it needs and warns on Settings when the servers on the relay would go past 4 of either kind.

## Games

Tunnels are plain TCP or UDP, so there is no per-game protocol handling. Ports used by the shipped templates:

| Game | Ports to tunnel | Notes |
| --- | --- | --- |
| Minecraft | 25565/tcp | |
| Palworld | 8211/udp, 27015/udp | 8211 is the game port; the 27015 query port is only needed for server-list discovery but the panel plans it too. |
| Valheim | 2456/udp, 2457/udp | Valheim uses the next port too, so it needs two UDP tunnels. |
| Terraria | 7777/tcp | |
| Satisfactory | 7777 (tcp+udp), 8888/tcp | Two tunnels, because 7777 is one `both` tunnel. |
| Dragonwilds | 7777/udp, 8888/udp | |

The public port is assigned by playit.gg and usually differs from the game's own, so players are given the `host:port` the agent reports.

**Unverified:** that Palworld, Valheim and Satisfactory work end to end through playit.gg. UDP games behind any relay can fail on server-list or query behaviour even when direct join works.

## Terms that matter

- playit.gg is a hosted service. Players' traffic passes through its servers, so the relay trades a visible home IP for trusting playit.gg with traffic and uptime.
- The agent is open source (BSD-2-Clause); the relay service itself is not. Users need their own free account. The panel never creates one.
- The terms of service were not read in full. Anyone shipping this to many people should read the current terms at https://playit.gg/.

## Where the key lives

The secret key is saved encrypted in the `settings` table (the same AES-256-GCM scheme as the Cloudflare token). It is checked against playit.gg before it is saved, is never returned by the API and is never logged or put in an error message. In managed mode it is passed to the agent container as `SECRET_KEY`, so anyone who can read that container's environment (Docker access, which the panel already needs) can read it.
