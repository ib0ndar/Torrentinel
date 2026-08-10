# Changelog

All notable changes to Torrentinel are documented in this file.

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

[0.2.0]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.2.0
[0.1.0]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.1.0
