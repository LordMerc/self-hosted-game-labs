# Contributing

Thanks for helping. This is a small project, so the rules are short.

## How changes get in

1. Nobody pushes straight to `main`, the maintainer included. Every change goes on a branch and into a pull request, so CI checks it first.
2. Make a branch (`git checkout -b my-change`), commit, push it and open a pull request. The template asks a few plain questions.
3. CI runs the unit tests, the type checks and a browser test. All of them must pass.
4. The maintainer reviews and merges.

Small pull requests are easier to review than big ones. If you want to build something large, open an issue first so we can agree on the idea.

## Running it on your computer

You need Node 22 and Docker.

```sh
npm ci
npm run dev:server   # the API
npm run dev:web      # the web page (second terminal)
```

## Running the checks

Run these before you open a pull request. They are the same things CI runs.

```sh
npm run typecheck
npm test
npm run build:web && npm run test:e2e   # browser test, needs Chromium (npx playwright install chromium)
```

The tests use a fake Docker and a fake router, so they run anywhere. They cannot tell you a game really starts, so if you change a game template or anything that talks to Docker, the router or Cloudflare, say in the pull request what you ran it against.

## Adding a game

Games are plain files in `templates/`. Copy a similar one (`templates/terraria.yaml` is a good start), then:

- Check the image name, ports and settings against the image's own documentation.
- Run the template tests (`npm test`); they reject unknown or unsafe settings.
- Deploy it on a real Docker host if you can, and say what you saw in the pull request.

Templates cannot ask for privileged containers, host networking or bind mounts. That is on purpose.

## Reporting a problem

Use the issue forms. For a bug, include what you did, what you expected and what happened. Please leave out passwords, API tokens and your public IP.
