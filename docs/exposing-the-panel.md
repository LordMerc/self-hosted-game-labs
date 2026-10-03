# Exposing the panel safely

Your friends need to reach your **game servers**. They never need to reach the **panel**. Keep those two things apart and most of the risk goes away.

## The short version

- **Open the game ports. Do not open the panel's port (8090 by default).** The panel can start and stop Docker containers on your machine, which is close to full control of it. Anyone who gets into the panel gets into your server.
- To use the panel when you are away from home, the safest way is a VPN such as [Tailscale](https://tailscale.com) or WireGuard. Then nothing about the panel is on the internet at all.
- If you do want a web address for it (`panel.example.com`), put it behind an HTTPS reverse proxy or a tunnel, as described below, and set `TRUST_PROXY` so the sign-in protection can see who is really connecting.
- **Finish the first-run password screen straight away.** Until a password exists, anyone who can reach the panel can set one.

## What the game servers need

Each game server uses a few ports, shown on its card in the panel (for example Palworld uses 8211/udp and 27015/udp). Make those, and only those, reachable from the internet:

- **UPnP:** set `CONNECTIVITY=upnp` and the panel opens and closes them on your router when you flip a server between Private and Public.
- **Manual:** leave `CONNECTIVITY=manual`. The panel shows the exact rules to add to your router's port forwarding page.

Private servers have no router rules at all. A server only becomes reachable from outside when you set it to Public.

A domain name for a server (`palworld.example.com`) must be a plain "DNS only" record, which is what the panel creates. Cloudflare's orange-cloud proxy and Cloudflare Tunnel do not carry game traffic. They are only for the panel's web page, if you choose to use one.

## What the panel already does to protect itself

- **Sign-in lockout.** After 5 wrong passwords from one address, that address is locked out for 15 minutes. Each repeat doubles the wait, up to 4 hours. A correct password resets the count. While locked out, even the right password is refused, so a guesser gets nothing from trying.
- **Panel-wide pause.** If 30 wrong passwords arrive within 15 minutes from different addresses (a sign of guessing from many places at once), sign-ins pause for 5 minutes.
- **Locked yourself out?** Wait, or restart the panel's container. The lockout list lives in memory, so a restart clears it.
- **Session cookie.** It is `HttpOnly`, `SameSite=Strict`, signed, and marked `Secure` whenever you visited over HTTPS (see `COOKIE_SECURE` below). Over HTTPS the panel also sends `Strict-Transport-Security`.
- **Other headers.** The panel refuses to be shown inside another site's frame, refuses to let browsers guess file types, and tells browsers not to cache its API answers.
- **A warning on the sign-in page** if you reach the panel over plain `http://` using a public name. Plain HTTP is fine on your home network (the warning stays quiet for local addresses), but not for a name on the internet, because the password would travel unprotected.

Two limits to know about: the lockout is kept in memory, and signing out only removes the cookie from your browser. A session lasts 7 days, and the way to end every session at once is to change `SESSION_SECRET` and restart.

## Putting the panel behind a reverse proxy

A reverse proxy is a small web server that takes HTTPS from the internet and passes it on to the panel. It handles the certificate; the panel stays on plain HTTP behind it.

Before you start:

1. The panel and the proxy should talk to each other privately. If the proxy runs on the same machine, set `PANEL_HOST=127.0.0.1` so the panel only answers to that machine. People on your network can no longer reach it directly, only through the proxy. (The compose files use host networking, so this just works for a proxy running on the host.)
2. Set `TRUST_PROXY` to the address the proxy connects **from** (below). Without it, the panel thinks every visitor is the proxy, so one person's wrong passwords would lock out everyone, and the cookie would not be marked Secure.
3. Open ports 80 and 443 for the proxy if it needs them for its certificate. Not 8090.

### `TRUST_PROXY`

It tells the panel whose word to take about the visitor's address and about whether the visit used HTTPS. Use the narrowest value that fits:

| Where the proxy runs | Set `TRUST_PROXY` to |
| --- | --- |
| On the same machine, outside Docker (or with host networking) | `127.0.0.1` |
| In another Docker container on this machine | the Docker network it uses, for example `172.18.0.0/16` (find it with `docker network inspect <network>`) |
| On another machine on your network | that machine's address, for example `192.168.1.20` |

You can list several, separated by commas. The words `loopback`, `linklocal` and `uniquelocal` also work. **Avoid `true`** unless nothing but the proxy can reach the panel: with `true`, anyone who can reach the panel directly can claim any address they like and dodge the lockout.

### Caddy

[Caddy](https://caddyserver.com) gets and renews the HTTPS certificate by itself. A `Caddyfile` on the same machine:

```
panel.example.com {
    reverse_proxy 127.0.0.1:8090
}
```

Then set `PANEL_HOST=127.0.0.1` and `TRUST_PROXY=127.0.0.1` on the panel. Caddy passes the visitor's address and `https` along automatically.

### Nginx

With a certificate from [certbot](https://certbot.eff.org) (or any other), a server block like this:

```nginx
server {
    listen 443 ssl;
    server_name panel.example.com;
    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        # The Logs window streams: do not hold the output back.
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}

server {
    listen 80;
    server_name panel.example.com;
    return 301 https://$host$request_uri;
}
```

Set `PANEL_HOST=127.0.0.1` and `TRUST_PROXY=127.0.0.1`. Note `X-Forwarded-For $remote_addr` (not `$proxy_add_x_forwarded_for`): it replaces whatever the visitor sent instead of adding to it.

### Cloudflare Tunnel (`cloudflared`)

If you already run `cloudflared`, you do not need to open any port at all: the tunnel makes an outbound connection to Cloudflare, and Cloudflare serves the HTTPS page. In the Zero Trust dashboard, add a **public hostname** to your tunnel, for example `panel.example.com`, with service `http://localhost:8090`.

- `cloudflared` runs on the host (or with host networking): use `localhost:8090`, `PANEL_HOST=127.0.0.1` and `TRUST_PROXY=127.0.0.1`.
- `cloudflared` runs in a normal Docker container: `localhost` is the container itself, so point it at the machine's LAN address, for example `http://192.168.1.50:8090`. Leave `PANEL_HOST` alone, and set `TRUST_PROXY` to the Docker network the container uses (see the table). The panel's port is then still reachable from your home network, which is fine. Just do not forward it on your router.

Because Cloudflare sees every visit, it is worth adding **Cloudflare Access** (Zero Trust; the free plan covers a small group) to that hostname, so Cloudflare asks for an email login before the panel's own password screen appears. That gives you two locks instead of one, and strangers never get to see the panel's sign-in page.

Remember that this tunnel is only for the panel's web page. Game traffic cannot go through it. Players still connect to your home IP on the game ports.

## Checklist

- [ ] The admin password is set, and it is long (a few random words is better than a short clever one).
- [ ] The panel's port is **not** forwarded on your router.
- [ ] Only the game ports of servers set to Public are forwarded.
- [ ] If you use a web address for the panel: it is HTTPS, `TRUST_PROXY` is set to the proxy's address, and `PANEL_HOST=127.0.0.1` if the proxy is on the same machine.
- [ ] Visiting `https://panel.example.com` shows no warning on the sign-in page.
- [ ] Optional but good: a VPN or Cloudflare Access in front.

## Settings in this guide

| Variable | Default | What it does |
| --- | --- | --- |
| `PANEL_HOST` | `0.0.0.0` | Address the panel listens on. `127.0.0.1` makes it reachable only from this machine. |
| `TRUST_PROXY` | empty (no proxy) | Which proxies to believe about the visitor's address and HTTPS. See above. |
| `COOKIE_SECURE` | `auto` | `auto` marks the session cookie Secure when the visit used HTTPS. `always` forces it, `never` turns it off. |
| `UPDATE_CHECK` | `on` | `off` stops the daily new-version check (below). |

## New version notice

Once a day the panel asks GitHub for this project's newest release (`api.github.com/repos/LordMerc/self-hosted-game-labs/releases/latest`) and compares its number with the version you run. If a newer one exists, a line appears at the top of the Game servers page with a link to the release notes. You can close it, and it comes back only for the next release.

- It sends no information about you or your machine, only an ordinary web request that carries the program name and version. GitHub sees your IP address, like any website you visit.
- The panel **never installs updates by itself.** To update, pull the new image or redeploy the stack, as you do today.
- Switch it off on the **Settings** page ("Check for new versions once a day"), or for good with `UPDATE_CHECK=off`.
- Development builds (the `:beta` preview image and builds made from source, labelled `dev-<commit>`) have no release number, so they never show the notice. If you build from the source yourself, the version is the one in `package.json`.
