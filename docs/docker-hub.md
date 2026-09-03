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

The experimental `torrentinel_integrated` branch provides one complete Torrentinel container with its Patchright browser, stores application data in named volumes, and includes a health check. It does not require or expose a browser sidecar. Kinozal login/search and RuTracker detail/recovery traffic use the browser when interactive verification is required.

The canonical repository contains the current Compose file, Podman Quadlets, direct Linux instructions, configuration reference, backup guidance, screenshots, and release notes:

**[github.com/ib0ndar/Torrentinel](https://github.com/ib0ndar/Torrentinel)**

Use the branch-specific installation commands from the repository README. The integrated canary is published as `bah0/torrentinel:v0.5.0-integrated.3` for `linux/amd64` and `linux/arm64`; it remains separate from the stable `bah0/torrentinel:latest` image.

## Important operational notes

- Change the initial administration password immediately after first sign-in.
- Do not publish or mount the integrated browser profile separately; protect it as part of the application-data volume.
- Back up the database and application-data volumes together because encrypted integrations require the matching generated key.
- Read the changelog and create a backup before upgrading this pre-1.0 project.

Torrentinel is licensed under the GNU Affero General Public License v3.0. Operators are responsible for following tracker rules and applicable law.
