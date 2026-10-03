# Card artwork

Each game card has a banner. By default it is a colour gradient with the game's first letter. A template can replace that with a picture.

## How a template asks for one

```yaml
artwork: https://example.com/press/key-art.webp   # or a path inside templates/, such as artwork/palworld.webp
artworkCredit: Press kit at example.com/press, free for non-commercial community use
```

- A link must be `https`, name a public host (no IP addresses, no `localhost` or `.local` names), have no credentials, port or `#` part, and end in `.png`, `.jpg` or `.webp`.
- `artworkCredit` is up to 300 characters and shows as a tooltip on the banner. Put the source URL and the terms in it.
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

No game template links artwork yet. Each publisher was checked for an official press or fan kit and for terms that allow using the art in third-party software. The bar was a stated allowance for non-commercial fan or community use, not just permission for fan-made works. None met it, so every card keeps its gradient. Asking a publisher for permission is the next step if a game's card should have a picture.

| Game | Outcome | What was found |
| --- | --- | --- |
| Palworld | Gradient kept | No press kit found. Pocketpair's derivative-works guideline covers fan creations, not reuse of official art in other software. |
| RuneScape: Dragonwilds | Gradient kept | Jagex's Fan Content Policy covers fan-made content and in-game captures, not official key art in third-party tools. |
| Minecraft Java | Gradient kept | Minecraft's brand and usage guidelines are strict and give no clear allowance for this. |
| Valheim | Gradient kept | The press kit is a shared drive folder with no stated terms and no direct image links. |
| Satisfactory | Gradient kept | The press kit is a shared drive folder with no stated terms and no direct image links. |
| Terraria | Gradient kept | No press kit with usable terms was found. |

Terms change. If you add a picture later, record the source URL and the terms in `artworkCredit` and in this table, with the date you checked.
