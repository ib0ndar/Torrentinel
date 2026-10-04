# Torrentinel

**A private, self-hosted monitor for torrent release changes.**

[![Torrentinel product tour](https://raw.githubusercontent.com/ib0ndar/Torrentinel/main/docs/screenshots/product-tour.gif)](https://github.com/ib0ndar/Torrentinel)

Torrentinel watches selected tracker releases and phrase rules over time. It records changes to titles, artwork, magnets, torrent files, and metadata, discovers new phrase matches, and can send Telegram notifications.

Torrentinel complements download clients and media automation. It does not download torrents or act as a general-purpose indexer.

## Highlights

- Direct release monitoring with persistent change history
- Phrase-based release discovery with required and ignored terms
- Telegram notifications with artwork and release links
- Multi-user collections and administration
- One unread activity indicator; opening details marks activity read, with manual unread reminders available
- Encrypted tracker credentials and Telegram tokens
- Feed-overlap diagnostics and authenticated RuTracker gap recovery
- Source-built Linux container support for `amd64` and `arm64`

## Supported trackers

| Tracker | Direct links | Rules | Login |
| --- | --- | --- | --- |
| Kinozal | Yes | Yes | Required |
| Rutor | Yes | Yes | No |
| RuTracker | Yes | Yes | Optional for normal monitoring; required for authenticated gap recovery |

## Deployment

Torrentinel ships as one complete container with its Patchright browser, stores application data in named volumes, and includes a health check. It does not require or expose a browser sidecar. Kinozal login/search and RuTracker detail/recovery traffic use the browser when interactive verification is required, while Rutor stays on direct HTTP unless a challenge triggers the browser fallback.

The canonical repository contains the current Compose file, Podman Quadlets, direct Linux instructions, configuration reference, backup guidance, screenshots, and release notes:

**[github.com/ib0ndar/Torrentinel](https://github.com/ib0ndar/Torrentinel)**

Use the release installation commands from the repository README. Stable images are published as `bah0/torrentinel:vX.Y.Z` and `bah0/torrentinel:latest` for `linux/amd64` and `linux/arm64`.

## Important operational notes

- There is no default password. The first start generates one for the account `admin`, prints it in the log line starting `First sign-in:`, and saves it in `/var/lib/torrentinel/initial-admin-password` until it is changed; set `INITIAL_ADMIN_PASSWORD` to choose it instead.
- Torrentinel answers only IP addresses, local names, the host of `PUBLIC_URL`, and names in `ALLOWED_HOSTS`, which protects it from DNS rebinding. Add any domain you open it under.
- Do not publish or mount the integrated browser profile separately; protect it as part of the application-data volume.
- With Docker, run the container with the repository's `deploy/torrentinel-seccomp.json` (`--security-opt seccomp=torrentinel-seccomp.json`), as the supplied Compose file does, so the integrated browser can use Chrome's sandbox; Podman's default profile already allows it. Without it, Chrome runs unsandboxed and Torrentinel logs a warning.
- Back up the database and application-data volumes together because encrypted integrations require the matching generated key.
- Read the changelog and create a backup before upgrading this pre-1.0 project.

Torrentinel is licensed under the GNU Affero General Public License v3.0. Operators are responsible for following tracker rules and applicable law.
