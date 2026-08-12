# Changelog

All notable changes to Torrentinel are documented in this file.

## [0.2.3] - 2026-08-12

### Changed

- Kinozal rule subscriptions now use phrase-specific catalogue searches instead of the incomplete generic recent-release page.
- Identical Kinozal searches are shared between rules during each polling run.
- Tracker diagnostics now identify search phrases, discovery revisions, and silent-baseline activity.

### Fixed

- Kinozal releases omitted from its generic recent list can now be discovered by rule subscriptions.
- Existing Kinozal rules establish a one-time silent search baseline after upgrading, preventing historical catalogue matches from generating false notifications.

## [0.2.2] - 2026-08-10

### Fixed

- Versioned the external SVG icon-sprite URL so browsers cannot combine a new interface bundle with an older cached sprite after an upgrade.
- Restored the unread circle-and-dot icon for clients that had cached the pre-0.2.1 sprite.

## [0.2.1] - 2026-08-10

### Added

- The currently running version is displayed beneath the account control in the desktop sidebar and links to its GitHub release.
- Container builds embed their source revision, which appears in the version tooltip for precise build identification.

### Changed

- Read state now uses a muted circular check, while unread state uses a matching luminous circle with a center dot.
- Read/unread controls now announce both their current state and toggle action to assistive technology.

## [0.2.0] - 2026-08-10

### Added

- Multi-architecture Docker Hub images for `linux/amd64` and `linux/arm64`.
- A Docker Compose deployment with separate application and SQLite named volumes and a private FlareSolverr sidecar.
- Docker deployment documentation and fictional-data interface screenshots in the project README.

### Changed

- Direct-subscription titles are now owned by the tracker snapshot instead of a separate user-maintained display name.
- Direct-subscription creation and editing now focus on the tracker URL; the tracker title is populated automatically.

### Fixed

- A changed direct-subscription title is immediately reflected in both the collection list and subscription details.
- Every successful direct check synchronizes the stored title, repairing records left stale by earlier releases without generating duplicate events or Telegram notifications.

## [0.1.0] - 2026-08-09

### Initial release

- Direct-link and case-insensitive rule subscriptions for Kinozal, Rutor, and RuTracker.
- Per-user collections, read/unread and updated state, private tracker access, and custom mirrors.
- Telegram account linking and rich release notifications.
- Rootless Podman deployment with separate application and SQLite named volumes.
- Modular native TypeScript tracker adapters and a browser-backed RuTracker detail provider.
- Administrator-controlled polling from 5 minutes to 6 hours.
- Tracker diagnostics in the Administration interface with a fixed 168-hour retention window.
- Explicit Rutor missing-release detection that preserves the last valid direct-subscription snapshot.

[0.2.3]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.2.3
[0.2.2]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.2.2
[0.2.1]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.2.1
[0.2.0]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.2.0
[0.1.0]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.1.0
