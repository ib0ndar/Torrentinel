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
- Published Linux images for `amd64` and `arm64`

## Supported trackers

| Tracker | Direct links | Rules | Login |
| --- | --- | --- | --- |
| Kinozal | Yes | Yes | Required |
| Rutor | Yes | Yes | No |
| RuTracker | Yes | Yes | Optional for normal monitoring; required for authenticated gap recovery |

## Deployment

Docker Compose is the recommended complete container deployment. It starts Torrentinel and a private FlareSolverr sidecar, stores application data in named volumes, and includes a health check.

The canonical repository contains the current Compose file, Podman Quadlets, direct Linux instructions, configuration reference, backup guidance, screenshots, and release notes:

**[github.com/ib0ndar/Torrentinel](https://github.com/ib0ndar/Torrentinel)**

Use the installation commands from the repository README. They resolve GitHub's latest stable release automatically, ensuring that the deployment files and `bah0/torrentinel` image use the same version.

## Important operational notes

- Change the initial administration password immediately after first sign-in.
- Keep FlareSolverr on its private container network; never publish its API port.
- Back up the database and application-data volumes together because encrypted integrations require the matching generated key.
- Read the changelog and create a backup before upgrading this pre-1.0 project.

Torrentinel is licensed under the GNU Affero General Public License v3.0. Operators are responsible for following tracker rules and applicable law.
