<meta name="google-site-verification" content="xchJFmR-94RP-zCzAMkMpK2YC7ROKEFirdHPKYobe_0" />

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ib0ndar/Torrentinel/main/public/brand/torrentinel-lockup.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/ib0ndar/Torrentinel/main/public/brand/torrentinel-lockup-light.svg">
    <img src="https://raw.githubusercontent.com/ib0ndar/Torrentinel/main/public/brand/torrentinel-lockup-light.svg" alt="Torrentinel" width="420">
  </picture>
</p>

<p align="center">
  A private, self-hosted monitor for torrent release changes.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
  <a href="https://github.com/ib0ndar/Torrentinel/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/ib0ndar/Torrentinel/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://hub.docker.com/r/bah0/torrentinel"><img alt="Docker image" src="https://img.shields.io/docker/v/bah0/torrentinel?sort=semver&amp;label=image"></a>
  <a href="https://github.com/ib0ndar/Torrentinel/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/ib0ndar/Torrentinel"></a>
</p>

Torrentinel is a self-hosted watchlist and change-detection service. It monitors selected tracker releases, detects changes to titles, artwork, magnets, torrent files, and metadata, discovers new phrase matches, keeps per-user history, and sends Telegram notifications.

> [!IMPORTANT]
> This `torrentinel_integrated` branch is an experimental canary. It replaces the FlareSolverr sidecar with a Patchright-controlled browser inside the Torrentinel image. Keep it separate from the production deployment and its data volumes until Kinozal and RuTracker monitoring have been observed over time.

<p align="center">
  <img src="docs/screenshots/product-tour.gif" alt="Torrentinel product tour showing release monitoring, change history, and tracker diagnostics" width="960">
</p>

## Why Torrentinel?

Torrentinel is designed for people who want to follow releases over time, including changes to an existing tracker topic. It complements download clients and media automation rather than replacing them.

**Use Torrentinel when you want to:**

- Watch specific tracker pages for later changes
- Discover new posts matching simple required and ignored phrases
- Keep private per-user collections, history, and read state
- Receive Telegram notifications without connecting a download client

## Quick start with Docker Compose

This is the shortest complete deployment. It builds one Torrentinel image containing the application, Patchright, Chrome or Chromium, and a private virtual display. No browser sidecar or second service is required.

```sh
git clone --branch torrentinel_integrated --depth 1 \
  https://github.com/ib0ndar/Torrentinel.git Torrentinel-integrated
cd Torrentinel-integrated
cp .env.example .env
# Edit .env now if the public URL or host port will differ.
docker compose config
docker compose build
docker compose up -d
curl -fsS http://127.0.0.1:18080/api/health
```

Open the configured URL and complete the [first sign-in](#first-sign-in).

## Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Supported trackers](#supported-trackers)
- [Project status and platform scope](#project-status-and-platform-scope)
- [Installation](#installation)
  - [Direct installation on Linux](#direct-installation-on-linux)
  - [Docker Compose](#docker-compose)
  - [Podman Quadlet](#podman-quadlet)
- [Configuration](#configuration)
- [Operations and backups](#operations-and-backups)
- [Development and contributing](#development-and-contributing)
- [Responsible use and license](#responsible-use-and-license)

## Features

- Direct-link monitoring for title, cover, magnet, torrent-file, and metadata changes
- Case-insensitive rule subscriptions with required and ignored phrases
- Per-user collections, history, and read/unread state
- Telegram notifications with artwork and release links
- Persistent cover fallback when an image host is temporarily unavailable
- Tracker credentials, mirrors, and Telegram bots configured from the web interface
- Administrator-managed accounts with no public registration
- Configurable polling from 5 minutes to 6 hours
- Persistent RuTracker feed buffering with overlap monitoring and authenticated gap recovery
- Integrated Patchright browser for Kinozal login/search, RuTracker detail access, and challenge-only Rutor fallback
- Tracker diagnostics with seven-day log retention
- Encrypted credentials and bot tokens in SQLite
- Modular TypeScript tracker adapters
- Source-built container support for `linux/amd64` and `linux/arm64`

## Screenshots

### Monitor

![Torrentinel monitor workspace](docs/screenshots/monitor-workspace.png)

### Subscription details

![Torrentinel subscription details](docs/screenshots/subscription-details.png)

### Administration

![Torrentinel administration and tracker diagnostics](docs/screenshots/administration-diagnostics.png)

## Supported trackers

| Tracker | Direct links | Rules | Login |
| --- | --- | --- | --- |
| [Kinozal](https://kinozal.tv/) | Yes | Yes | Required |
| [Rutor](https://rutor.is/) | Yes | Yes | No |
| [RuTracker](https://rutracker.org/) | Yes | Yes | Optional |

## Project status and platform scope

Torrentinel is pre-1.0 software. Releases may change configuration, tracker behavior, or database structure. Database migrations run automatically at startup, but rollback is not guaranteed; read the [changelog](CHANGELOG.md) and create a paired backup before every update.

Direct installation on a Linux host is supported with Node.js 22.20 or newer and a Patchright-compatible browser. The supplied systemd unit is the maintained service definition for this deployment method. Source-built container images target Linux on `amd64` and `arm64`; Docker Desktop may run them, but macOS and Windows hosts are not part of the maintained deployment test matrix.

Torrentinel does not claim a fixed CPU or RAM minimum because tracker activity and browser use vary. The integrated browser is the heaviest component and starts when Kinozal or RuTracker needs it, or when Rutor's HTTP fast path encounters an interactive challenge. The supplied container definitions provide 512 MiB of shared memory. Small hosts should monitor memory during browser-backed tracker operations.

## Installation

Torrentinel can be installed directly on a Linux host as a Node.js service, without Docker, Podman, or another container runtime. It can also run as one container. The integrated browser is launched by Torrentinel and retains reusable clearance state in the application-data directory.

| Method | Best for | Browser-backed tracker access | Host requirements |
| --- | --- | --- | --- |
| [Direct Linux installation](#direct-installation-on-linux) | Minimal overhead and direct service integration | Included when a compatible browser is installed | Node.js 22.20+, npm, Chrome/Chromium, a service manager |
| [Docker Compose](#docker-compose) | The shortest complete installation | Included | Docker Engine and Compose v2 |
| [Podman Quadlet](#podman-quadlet) | Rootless, systemd-managed containers | Included | Podman with Quadlet, systemd user services, cgroup v2 |

All methods require Git and `curl`, plus outbound HTTPS access to the configured trackers and Telegram when notifications are enabled. Container examples use the separately tagged experimental image `bah0/torrentinel:v0.5.0-integrated.4`; it does not replace the stable `latest` channel. Choose the final HTTP port and `PUBLIC_URL` before linking Telegram or placing Torrentinel behind a reverse proxy.

### Direct installation on Linux

Install a system-wide Node.js 22.20 or newer release, npm, and Git using the method recommended by your Linux distribution. Python 3, `make`, and a C/C++ compiler may also be required when npm cannot use a prebuilt native module. Confirm the runtime before continuing:

```sh
node --version
npm --version
git --version
```

Create a dedicated system account named `torrentinel` with your distribution's account-management tool. The account does not need an interactive shell. Build on the target host, or on a Linux system with the same architecture, libc, and Node.js ABI:

```sh
git clone --branch torrentinel_integrated --depth 1 \
  https://github.com/ib0ndar/Torrentinel.git Torrentinel-integrated
cd Torrentinel-integrated
npm ci
npm run build
npm prune --omit=dev
```

Install the built application, persistent directories, environment file, and supplied systemd unit:

```sh
sudo install -d -m 0755 /opt/torrentinel
sudo cp -a dist node_modules package.json package-lock.json /opt/torrentinel/
sudo install -d -o torrentinel -g torrentinel -m 0750 \
  /var/lib/torrentinel/database \
  /var/lib/torrentinel/application
sudo install -d -m 0755 /etc/torrentinel
sudo install -o root -g torrentinel -m 0640 \
  deploy/native/torrentinel.env \
  /etc/torrentinel/torrentinel.env
sudo install -o root -g root -m 0644 \
  deploy/native/torrentinel.service \
  /etc/systemd/system/torrentinel.service
```

Edit `/etc/torrentinel/torrentinel.env`. Set `PUBLIC_URL` to the address users will open. The supplied configuration binds to `127.0.0.1`; set `HOST=0.0.0.0` only when the application should accept connections directly from the network.

Start Torrentinel and verify it locally:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now torrentinel.service
sudo systemctl status torrentinel.service --no-pager
curl -fsS http://127.0.0.1:8080/api/health
```

Direct installations must provide a Patchright-compatible Chrome or Chromium binary. Use `BROWSER_CHANNEL=chrome` for an installed Google Chrome, or `BROWSER_CHANNEL=chromium` for the browser installed by Patchright. Browser package and display setup varies by Linux distribution; Docker Compose is the reproducible deployment path for this experimental branch.

If the host does not use systemd, run `/usr/bin/env node /opt/torrentinel/dist/server/index.js` under its service manager with the variables from `deploy/native/torrentinel.env` and write access to both `/var/lib/torrentinel` subdirectories.

### Docker Compose

Docker Compose runs one Torrentinel container and stores persistent data in two named volumes. The application volume also retains the integrated browser profiles and their reusable login and challenge-clearance cookies.

```sh
git clone --branch torrentinel_integrated --depth 1 \
  https://github.com/ib0ndar/Torrentinel.git Torrentinel-integrated
cd Torrentinel-integrated
cp .env.example .env
```

Edit `.env`, especially `PUBLIC_URL`, `TORRENTINEL_PORT`, and `SESSION_COOKIE_SECURE`. Then validate and start the deployment:

```sh
docker compose config
docker compose pull
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:18080/api/health
```

If `TORRENTINEL_PORT` is changed, use that port in the health-check URL. View logs with the commands in the [operations guide](docs/operations.md#logs).

`docker compose ps` should list only `torrentinel-integrated`. Chrome runs inside that container and does not expose a separate API or network port. The default canary port and volumes are deliberately distinct from the stable deployment.

### Podman Quadlet

The supplied Quadlets run the separately tagged experimental container rootlessly under the current user's systemd manager. They are not specific to one Linux distribution, but they require Quadlet support and cgroup v2:

```sh
podman --version
podman info --format '{{.Host.CgroupsVersion}}'
systemctl --user --version
```

The cgroup command must report `v2`. Install the tagged deployment files and create a private local environment file:

```sh
git clone --branch torrentinel_integrated --depth 1 \
  https://github.com/ib0ndar/Torrentinel.git Torrentinel-integrated
cd Torrentinel-integrated
podman pull docker.io/bah0/torrentinel:v0.5.0-integrated.4
install -d -m 0700 "$HOME/.config/containers/systemd"
install -m 0644 \
  deploy/*.container deploy/*.volume \
  "$HOME/.config/containers/systemd/"
install -m 0600 \
  deploy/torrentinel-integrated.env.example \
  "$HOME/.config/containers/systemd/torrentinel-integrated.env"
```

Edit `~/.config/containers/systemd/torrentinel-integrated.env`, particularly `PUBLIC_URL` and `SESSION_COOKIE_SECURE`. The supplied canary Quadlet publishes TCP port `18080`, separate from the stable deployment's default port. Enable the user manager at boot and start Torrentinel:

```sh
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user start torrentinel-integrated.service
systemctl --user status torrentinel-integrated.service --no-pager
curl -fsS http://127.0.0.1:18080/api/health
```

The `.volume` Quadlets create `torrentinel_integrated_app` and `torrentinel_integrated_db` automatically. If systemd does not generate `torrentinel-integrated.service`, follow the [Podman troubleshooting guidance](docs/operations.md#troubleshooting).

### First sign-in

Open the configured URL and sign in with:

```text
Username: admin
Password: admin
```

Torrentinel requires the default password to be changed immediately. Configure tracker accounts, mirrors, and Telegram bots under **Settings**. Manage users and the polling interval under **Administration**.

Do not expose a new installation to an untrusted network until the default administrator password has been changed.

## Configuration

A RuTracker login is optional for ordinary public-feed monitoring and required for authenticated recovery after a detected feed gap. The configured polling interval is the actual tracker request interval. Administration displays the rolling-feed window, consecutive-batch overlap, new-entry count, and safety margin.

Runtime settings are read from the process environment. The direct systemd installation uses `/etc/torrentinel/torrentinel.env`, Docker Compose uses `.env`, and Podman uses `~/.config/containers/systemd/torrentinel-integrated.env`.

| Setting | Direct Linux installation | Docker Compose | Podman Quadlet | Purpose |
| --- | --- | --- | --- | --- |
| `HOST` | `127.0.0.1`, editable | Fixed to image default `0.0.0.0` | Fixed to image default `0.0.0.0` | Application listen address |
| `PORT` | `8080`, editable | Internal port `8080` | Internal port `8080` | Application container/process port |
| `TORRENTINEL_PORT` | Not used | `18080`, editable | Not used | Docker canary host port mapped to internal `8080` |
| `PUBLIC_URL` | Editable | Editable | Editable | Externally reachable URL without a trailing slash |
| `DATA_DIR` | `/var/lib/torrentinel/database` | Fixed volume path `/data` | Fixed volume path `/data` | SQLite database directory |
| `APP_DATA_DIR` | `/var/lib/torrentinel/application` | Fixed volume path `/var/lib/torrentinel` | Fixed volume path `/var/lib/torrentinel` | Encryption key, cached covers, and browser profiles |
| `POLL_INTERVAL_MINUTES` | Editable, default `60` | Editable, default `60` | Editable, default `60` | Initial interval before an administrator saves a value |
| `POLL_STARTUP_DELAY_SECONDS` | Editable, default `20` | Editable, default `20` | Editable, default `20` | Delay before the startup poll |
| `TRACKER_REQUEST_TIMEOUT_MS` | Editable, default `30000` | Editable, default `30000` | Editable, default `30000` | Tracker HTTP timeout |
| `BROWSER_TIMEOUT_MS` | Editable, default `120000` | Editable, default `120000` | Editable, default `120000` | Integrated browser navigation and challenge timeout |
| `BROWSER_HEADLESS` | Editable, default `true` | Editable, default `false` | Editable, default `false` | Use headless mode; containers use a private virtual display by default |
| `BROWSER_CHANNEL` | Editable, default `auto` | Editable, default `auto` | Editable, default `auto` | `auto` selects Chrome on `amd64` and bundled Chromium on `arm64` |
| `SESSION_DAYS` | Editable, default `30` | Editable, default `30` | Editable, default `30` | Login-session lifetime |
| `SESSION_COOKIE_SECURE` | Editable, default `false` | Editable, default `false` | Editable, default `false` | Set to `true` when the public URL uses HTTPS |

The standalone container image accepts all runtime variables directly. The supported Compose and Quadlet definitions intentionally fix their internal listen ports and data paths; use the documented host-port setting instead of changing container internals.

Tracker passwords and Telegram tokens are configured only in the web interface and are never environment variables.

### Reverse proxy and HTTPS

When a reverse proxy terminates HTTPS, point it at Torrentinel's host port, set `PUBLIC_URL` to the final `https://` address, and set `SESSION_COOKIE_SECURE=true`. The native service binds to loopback by default and is ready for this arrangement. Container ports bind on the host, so restrict them with the host firewall when only the reverse proxy should have access. The integrated browser has no listening port.

## Telegram notifications

Each Torrentinel user can connect a separate Telegram bot and account:

1. Create a bot with Telegram's [BotFather](https://t.me/BotFather).
2. Save the bot token in Torrentinel under **Settings**.
3. Generate a linking code and send the displayed `/start` command to the bot.

`PUBLIC_URL` must be reachable from the Telegram client for Torrentinel-hosted Magnet buttons to work.

## Architecture

```mermaid
flowchart LR
  Browser["Web interface"] --> App["Torrentinel<br/>Fastify + React"]
  App --> DB["SQLite"]
  App --> Plugins["Tracker adapters"]
  Plugins --> IntegratedBrowser["Integrated Patchright browser"]
  Plugins --> Trackers["Kinozal · Rutor · RuTracker"]
  IntegratedBrowser --> Trackers
  App --> Telegram["Telegram Bot API"]
```

The API, React interface, scheduler, Telegram worker, and SQLite access run in one Node.js process. RuTracker can start one serialized Chrome child process on demand; both processes remain inside the same service or container. Tracker-specific behavior is isolated behind shared direct-subscription and rule-discovery contracts under `server/trackers/plugins/`.

## Operations and backups

The [operations guide](docs/operations.md) contains health-response details, service and log commands, updates, paired backups, restoration precautions, troubleshooting, and uninstall instructions for all three deployment methods.

> [!IMPORTANT]
> The SQLite database and application-data directory form one backup set. The database contains encrypted integrations, while the matching generated key is stored in application data. Always stop Torrentinel and back up or restore both together.

## Development and contributing

Torrentinel requires Node.js 22.20 or newer.

```sh
npm ci
npm run dev:server
```

Start the web interface in another terminal with `npm run dev:web`. Run the verification suite before submitting changes:

```sh
npm run check:release
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for tracker-adapter conventions, data-handling requirements, and the complete pull-request checks. Report vulnerabilities according to [SECURITY.md](SECURITY.md).

## Responsible use and license

Torrentinel is general-purpose monitoring software. Operators are responsible for ensuring that configured tracker access and use comply with each tracker's rules and with applicable law. Torrentinel does not grant tracker access or permission to collect or redistribute content.

Torrentinel is available under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version on a network server and allow users to interact with it, the AGPL requires offering those users the corresponding source code for that modified version.

Torrentinel was created with assistance from GPT models by [OpenAI](https://openai.com/). The generated code was reviewed, tested, and integrated by the project maintainer.
