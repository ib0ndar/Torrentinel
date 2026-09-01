# Changelog

All notable changes to Torrentinel are documented in this file.

## [0.4.3] - 2026-09-01

### Added

- A GitHub Actions verification workflow for tests, production builds, release-version consistency, Compose validation, and container builds.
- Security reporting and contribution policies, plus a dedicated operations guide covering updates, health checks, logs, backups, restores, troubleshooting, and uninstall procedures.
- An automated release-version check spanning the package metadata, changelog, README examples, Compose image, and Podman Quadlet image.

### Changed

- The README now opens with clear project positioning, suitability guidance, a Docker Compose quick start, navigation, project status, platform scope, and responsible-use guidance.
- Configuration settings distinguish user-configurable values from internal container defaults, while operations detail moves into focused documentation without reducing the three installation paths.
- Theme-aware branding, portable image URLs, imperative troubleshooting guidance, and reliable Mermaid line breaks improve GitHub rendering.

## [0.4.2] - 2026-08-31

### Added

- A distribution-neutral native Linux production path with a hardened systemd service and environment template.
- Declarative Podman volume Quadlets and a separate rootless-container environment template.

### Changed

- Installation guidance now presents native Linux, Docker Compose, and Podman Quadlet as three complete deployment scenarios with shared verification, update, troubleshooting, and backup guidance.
- Docker Compose forwards every documented runtime setting, while native and container data-path defaults are now distinguished accurately.
- Podman guidance is no longer tied to a specific Linux distribution, and persistent volumes are created automatically by Quadlet.

## [0.4.1] - 2026-08-31

### Changed

- RuTracker feed acquisition is recorded once per tracker run, while rule-evaluation observations show the distinct search terms and match counts that were evaluated against the shared batch.
- The first persisted feed sample is labeled as entries seeded with overlap unavailable, instead of implying that every entry was newly published.
- Existing retained rule observations also render their stored search terms instead of repeating tracker-level feed statistics.

## [0.4.0] - 2026-08-31

### Added

- RuTracker rule discovery now persists every observed Atom entry in a shared 14-day release buffer before evaluating subscriptions.
- Consecutive RuTracker feed batches are compared by topic ID, with entry counts, new entries, overlap, rolling-window duration, and polling safety margin visible in Administration.
- A non-overlapping feed window creates an explicit coverage gap and triggers authenticated, registration-date-sorted, paginated catch-up searches for every active RuTracker rule.
- RuTracker catch-up results are deduplicated through the existing rule-match store and coverage remains degraded until every active query reaches the recorded gap boundary.

### Changed

- The configured polling interval remains the sole tracker-request schedule; no hidden high-frequency RuTracker poller is used.
- RuTracker tracker logs distinguish feed entries scanned, new entries, overlap, buffered releases, matching releases, and recovery status instead of describing every feed entry as an observed release.
- RuTracker feed magnets are retained directly from Atom enclosure links.
- Authenticated recovery uses FlareSolverr only to obtain reusable Cloudflare clearance; tracker credentials are submitted directly by Torrentinel and never included in sidecar request payloads.

## [0.3.1] - 2026-08-29

### Changed

- Replaced collection, subscription, Telegram, tracker-login, and user-password browser prompts with accessible in-page dialogs that match the Torrentinel interface.
- Dialogs now provide focused input, keyboard submission, Escape and backdrop cancellation, focus trapping and restoration, responsive mobile layout, and distinct destructive-action styling.

## [0.3.0] - 2026-08-28

### Added

- Direct subscriptions now keep a persistent copy of their latest successfully retrieved cover in the application data volume.
- Tracker and Telegram diagnostics report cover-cache refreshes, retained fallbacks, and cached-photo deliveries.

### Changed

- The first successful direct-subscription check caches its cover while establishing the silent baseline.
- Every later direct-subscription update attempts to retrieve and atomically replace the cached cover, including when the tracker continues to publish the same image URL.
- Existing subscriptions without cached artwork automatically retry cover retrieval during successful checks until a cache is established.

### Fixed

- Telegram notifications use the most recently cached cover when an image host is temporarily unreachable, while continuing to retry the image host on future subscription updates.

## [0.2.7] - 2026-08-17

### Fixed

- Telegram cover uploads now retry HTTP/2 without a `Referer` header when an image host rejects hotlinked requests, fixing Fastpic images that deliberately returned HTTP 404 when the RuTracker page was supplied as the referrer.
- Successful cover fallbacks retain the failed retrieval stages in Administration diagnostics for future tracker and image-host investigations.

## [0.2.6] - 2026-08-17

### Added

- Telegram delivery diagnostics now retain sanitized artwork-fallback errors even when the final text or uploaded-photo message succeeds.
- The Administration interface shows the artwork fallback reason together with each Telegram delivery receipt.

### Fixed

- Cover retrieval now retries through secure HTTP/2 before falling back to a text-only Telegram notification, supporting image hosts such as Fastpic that reject Node.js's standard HTTPS client while serving the same image over HTTP/2.
- HTTP/2 cover downloads enforce HTTPS-only redirects, timeouts, image content types, and Telegram's photo-size limit before uploading the image to Telegram.

## [0.2.5] - 2026-08-12

### Added

- Persistent Telegram delivery receipts record delivered, failed, and skipped subscription notifications together with their final delivery method and Telegram message ID.
- Administrators can inspect Telegram delivery history in the web interface alongside tracker diagnostics; both retain only the latest 168 hours.

### Fixed

- Kinozal rule searches are now explicitly limited to titles and sorted by upload time in descending order instead of seed count, preventing older releases from drifting into the 50-result discovery window and being reported as new.
- Existing Kinozal rules establish one silent baseline after this discovery-order change, preventing the corrected result window from generating historical notifications.

## [0.2.4] - 2026-08-12

### Fixed

- Empty Kinozal catalogue searches are now treated as successful checks with no matches.
- Kinozal search parsing is restricted to the release-results table, preventing unrelated topic links from being stored as rule matches.

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

[0.4.3]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.4.3
[0.4.2]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.4.2
[0.4.1]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.4.1
[0.4.0]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.4.0
[0.3.1]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.3.1
[0.3.0]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.3.0
[0.2.7]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.2.7
[0.2.6]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.2.6
[0.2.5]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.2.5
[0.2.4]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.2.4
[0.2.3]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.2.3
[0.2.2]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.2.2
[0.2.1]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.2.1
[0.2.0]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.2.0
[0.1.0]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.1.0
