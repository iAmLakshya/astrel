# Astrel

Astrel comes from "a little star": a small, self-contained system that makes its own light.

This repo holds the page at <https://astrel.sh>. The page is static: one HTML file, one style sheet and one icon. It has no scripts. A small computer at home serves it, not a hosting service.

## Layout

| Path | Job |
| --- | --- |
| `site/` | The files of the page, and the page for errors |
| `Caddyfile` | The settings of the web server, with the security headers |
| `Dockerfile` | The image: Caddy and the files of the page |
| `test/smoke.sh` | Starts the image and checks the page and its headers |
| `.github/workflows/image.yml` | Builds and tests the image, and pushes it to the registry |
| `.github/dependabot.yml` | Proposes updates of the base image and of the actions |

## Run it on your computer

You need Docker.

1. Build the image:

   ```sh
   docker build -t astrel:dev .
   ```

2. Test the image:

   ```sh
   test/smoke.sh astrel:dev
   ```

3. Start the page:

   ```sh
   docker run --rm --read-only --tmpfs /data:uid=65534,gid=65534 -p 127.0.0.1:8080:8080 astrel:dev
   ```

4. Open <http://127.0.0.1:8080>. Press Ctrl+C in the terminal to stop it.

## How a change reaches astrel.sh

1. Push a change to `main`.
2. GitHub Actions builds the image and runs `test/smoke.sh` on it.
3. If the test passes, the workflow pushes the image to `ghcr.io/iamlakshya/astrel` with the tag `sha-<commit>`.
4. The summary of the run shows the image line with its digest. Copy that line into the homelab repo.
5. Deploy the homelab repo. The homelab pulls that exact image and starts it.

A pull request only builds and tests the image. It does not push it.

## Security

- The page has no scripts, forms, cookies or third-party requests. Its Content Security Policy blocks all other content.
- Caddy runs as the user `nobody`, with no Linux capabilities. The file system is read-only. Only `/data` is a small folder in memory, for the lock files of Caddy.
- Cloudflare holds the TLS certificate. Caddy speaks plain HTTP, and only the tunnel connector on the same computer can reach it.
- The base image and each action are pinned to a digest or a commit. Dependabot proposes each update.
