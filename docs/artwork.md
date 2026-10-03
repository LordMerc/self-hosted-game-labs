# Card artwork

Each game card has a banner. By default it is a colour gradient with the game's first letter. A template can replace that with a picture.

## How a template asks for one

```yaml
artwork: https://example.com/press/key-art.webp   # or a path inside templates/, such as artwork/palworld.webp
artworkCredit: Press kit at example.com/press, free for non-commercial community use
```

- A link must be `https`, name a public host (no IP addresses, no `localhost` or `.local` names), have no credentials, port or `#` part, and end in `.png`, `.jpg` or `.webp`.
- `artworkCredit` is up to 300 characters and shows as a tooltip on the banner. Put the source URL and the terms in it.
- `artworkPosition` (optional, 0 to 100, default 50) picks which part of a tall picture the banner keeps: 0 is the top, 100 the bottom. Minecraft uses 80 so the lettering near the top of its picture is cropped out.
- A card with artwork has the same size as one without. The picture gets a dark fade at the bottom, and the big letter is hidden.
- Use key art that reads well at about 2.4:1 (wide). A logo on its own does not make a good banner.

## How the panel handles a link

Browsers never contact the publisher. The panel's content security policy only allows images from itself.

1. When the panel starts it downloads each linked picture once into `<data folder>/artwork/`. Whatever is missing is tried again every hour, so a publisher being down does not matter for long.
2. The download is https only, gives up after 10 seconds, stops at 2 MiB, follows at most 3 redirects (each checked again), and refuses any host that resolves to a private, loopback or link-local address.
3. The file is identified by its first bytes, not by the server's `Content-Type` or the link's extension. Anything that is not a real png, jpg or webp is thrown away.
4. The panel serves the file at `/api/templates/<id>/artwork` to signed-in users. Until it has arrived, and whenever it fails, the card shows its gradient.
5. Changing the link in a template fetches the new picture and deletes the old one.

## What is shipped, and why

Every bundled game links its own store picture, so the cards look like the games. These are the publishers' store images, linked rather than copied into this repository: the panel fetches each one once for the person running it and keeps it in their data folder. They are **not** under an open license, and no publisher has given written permission for use in third-party software. I looked for press kits with fan or community terms first and found none that cover this (Palworld has no press kit; Jagex's fan policy covers fan-made content, not official art; Minecraft's guidelines are strict; the Valheim and Satisfactory press kits are shared drive folders with no stated terms; Terraria had none). Linking the store picture is the choice the maintainer made; if a publisher objects, delete the two lines from its template and the card goes back to the gradient.

| Game | Picture | Source |
| --- | --- | --- |
| Palworld | Steam library hero art | Steam app 1623730 |
| RuneScape: Dragonwilds | Steam library hero art | Steam app 1374490 |
| Minecraft Java | Store page key art | minecraft.net store page |
| Valheim | Steam library hero art | Steam app 892970 |
| Satisfactory | Steam library hero art | Steam app 526870 |
| Terraria | Steam header image | Steam app 105600 |

Each template's `artworkCredit` says the same thing in one line, and shows as a tooltip on the card. Steam's library hero images are wide, text-free key art that crop well to the banner; Terraria uses the header image because its hero art is plain scenery. A publisher can change or remove an image at any time, and the card then falls back to its gradient (or keeps the copy already downloaded).
