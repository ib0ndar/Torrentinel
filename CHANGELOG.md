# Changelog

All notable changes to Torrentinel are documented in this file.

## [Unreleased]

### Fixed

- The password change screen explains why a change is needed: after an administrator reset it says so and asks for the temporary password, and administrators created with a temporary password no longer see the first-run "Secure the admin account" wording. `GET /api/auth/me` returns `passwordChangeReason` (`initial`, `created`, or `reset`) while a change is required. The reason is stored in the existing `must_change_password` column, so there is no database change and earlier releases read it as before.
- Back/Forward and reloads return a long collection list (and other pages) to where you were, instead of near the top while the list is still loading.
- Closing details opened from an Unread list moves focus to the entry that took its place (or the selected filter) when the opened entry is no longer listed, instead of losing focus.
- Tracker icons in Diagnostics, Settings, and Administration keep their full width, so they line up across rows.

## [0.9.0] - 2026-10-04

### Added

- Change your own password under **Settings → Account** (current password, new password, confirmation), also reachable with **Change password** in the account menu on desktop and mobile. A successful change keeps you signed in and signs out the account's other browsers and devices.
- Settings opens with shortcuts to each section, and each section states whether it is saved automatically or needs its Save button.
- Tracker access rows in Settings and global mirror rows in Administration show **Unsaved changes** with a **Discard** action while edited. Save is only available when something changed and the values are valid; pressing Enter in a row saves it.
- Keyboard shortcuts on Monitor and Activity: `/` focuses the collection search, `j` / `k` move to the next or previous row (Enter opens it), `a` opens Add subscription, and `?` lists the shortcuts. They are ignored while typing in a field, with Ctrl/Cmd/Alt, and while a dialog, panel or menu is open. **Keyboard shortcuts** in the account menu shows the same list.
- The All, Unread and Errors filters in a collection show how many subscriptions each one holds, and the Activity Unread filter shows the unread total. `GET /api/collections` returns a new per-collection `errorCount` (subscriptions whose last check failed, as listed by the Errors filter).

### Changed

- Administration is split into **Overview** (scheduler, polling interval, RuTracker feed coverage), **Users**, **Mirrors**, and **Diagnostics** tabs, each with its own address (`/admin/overview`, `/admin/users`, `/admin/mirrors`, `/admin/diagnostics`). `/admin` opens Overview.
- Tracker logs and Telegram deliveries are paged on the server with your entries-per-page setting instead of showing only the latest 100 records. The tracker and outcome filters and the pages are kept in the address, so reloads, bookmarks, and Back/Forward return to the same view. The outcome filter lists every outcome recorded in the retention window.
- The notification queue, tracker logs, and Telegram deliveries show subscription names (rule phrases or the release title) instead of only numeric IDs, falling back to the ID when the subscription no longer exists.
- Notifications stack (up to three, newest at the bottom) instead of replacing each other and sit above the mobile bottom bar. Confirmations close after four seconds, or later while hovered or focused; errors stay until closed with their close button (or Escape) and are cleared when you sign in or out. Screen readers announce confirmations politely and errors immediately.
- Detail panels and forms that slide in from the side keep keyboard focus inside while open, start on the close button (or the first field), lock page scrolling, and return focus to where you were when closed.
- Background refreshes (collections, Activity, open details, scheduler status and the Telegram link check) pause while the browser tab is hidden and refresh once when you return.
- Filter buttons report which one is selected to assistive technology, and icon-only buttons have accessible names.
- The collection search field shows the short placeholder **Search** (Russian: «Поиск»), which fits on phones in both languages; screen readers still announce it as "Filter this collection" («Поиск в коллекции»).

### Fixed

- Tracker logins and the Telegram bot token are now entered in real forms, which removes the browser's "Password field is not contained in a form" warnings.
- Saving one tracker access row no longer discards unsaved edits in the other rows.
- Opening another page now starts at the top instead of keeping the previous page's scroll position; filter, sort and page changes keep the position.
- A member who reaches an old `/admin` address with Back/Forward now also gets the Monitor address in the address bar.
- Long outcome badges such as `temporarily-unavailable` wrap inside their column in the Diagnostics tracker logs instead of overflowing it.
- The Activity page no longer scrolls sideways on phones (and by a few pixels on tablets) when an entry shows a title change.
- On phones, the tracker choices in Add subscription and in a rule's edit form stack in one column instead of spilling past the panel's edge.

### Development

- `npm run check:ui` checks the main pages for layout problems at phone, tablet, and desktop widths and in Russian against an isolated fixture with fictional data, and saves screenshots to `output/ui-check/` (see CONTRIBUTING.md; needs Chromium or Chrome, not run in CI).
- The Settings and Administration pages are split into smaller section and tab components without changing their behavior.
- The web interface takes tracker choices, names, and capabilities from `GET /api/trackers` (loaded once per session, refreshed after tracker access or global mirrors are saved) instead of hard-coded lists; a tracker without marker assets gets a neutral letter badge.
- Tests no longer print Node's "localStorage is not available" warning: test workers run without Node's experimental Web Storage, so jsdom tests use jsdom's storage, which is cleared after each test.

### Upgrade notes

- No database changes; 0.8.0 runs unchanged against the same database. Back up the database and application-data directory together before updating, as usual.
- Changing your own password now signs out your other sessions, including after the forced first sign-in change.
- New administrator API endpoints: `GET /api/admin/diagnostics/observations` and `GET /api/admin/diagnostics/deliveries` (paged with `page` and `pageSize`) and `GET /api/admin/diagnostics/queue`. `GET /api/admin/diagnostics` is unchanged for other clients. `GET /api/collections` adds `errorCount` per collection.

## [0.8.0] - 2026-10-02

### Added

- Activity view (sidebar and mobile bottom bar) listing changes across all collections, newest first and grouped by day, with Unread and All filters, an unread badge, and Load more. Subscriptions marked unread by hand appear in a separate "Marked unread" group, and the badge counts exactly what the Unread view lists (unread changes plus those reminders). Opening an entry shows its details and marks it read.
- Mark all read for a collection (header, or the more-actions menu on mobile) and for everything (Activity), after a confirmation that states how many subscriptions are affected. Reminders set with Mark unread are cleared too.
- The selected collection, status filter, search, page, and sort are kept in the address (`/collections/…`), so reloads, bookmarks, new tabs, and Back/Forward return to the same view. Opening the app returns to the last used collection.
- Sort control in the collection list: Last change (default), Name (A–Z), or Needs attention first. Sorting runs on the server, so pages stay complete.
- Change history in subscription details shows what changed: the old and new title, and links to the new and previous magnet and torrent file. Rule events list the matched releases.
- Magnet and torrent-file actions for each rule match, in fixed columns that stay aligned when some matches lack one of them.

### Changed

- The collection list shows Last change instead of Last check (No changes yet when there are none); the last check is shown when hovering the time.
- Unread subscriptions keep their link or rule icon and show an accent dot, instead of replacing the icon with a bell.
- Page navigation is hidden when everything fits on one page, the top navigation is a single compact line, and Entries per page moved below the list. The mobile area above the list is much shorter.
- Collections in the sidebar and the mobile strip are links, so they can be opened in a new tab.
- The account control at the bottom of the sidebar now opens an account menu with Sign out, instead of signing out immediately.
- Mobile bottom navigation adds an Account item with the scheduler status, Sign out, and the release version.
- On mobile Monitor, the collections strip is a single row of compact chips (name and unread count) with the New collection button at the end, using less than half the previous height. The selected collection is kept in view.
- On mobile, Settings and Administration show a compact one-line collections switcher with the current collection. Expanding it reveals the collections strip.
- The sign-in form no longer pre-fills the default `admin` credentials.
- Rename, tracker-page, and sign-out actions use dedicated pencil, external-link, and sign-out icons.

### Fixed

- Subscription status badges, including Needs attention, are visible again on mobile, as are status badges in Settings and Administration.
- Collections can be renamed and deleted on mobile from a new more-actions menu in the collection header.
- When a session expires or becomes invalid while the app is open, the interface returns to the sign-in form with a single "Your session has expired" message and the username pre-filled, instead of repeatedly showing "Authentication required" errors.
- Members asked to change a temporary password (new accounts and administrator resets) no longer see the first-run "Secure the admin account" wording; the form asks for the temporary password. The password change screen also offers Sign out.
- A request that reports a required password change now opens the password change form instead of showing repeated errors.
- The Russian search field in the collection toolbar reads "Поиск" instead of "Поиск в коллекции", which was cut off on phones.

### Upgrade notes

- Startup adds the `idx_events_user_created` index on `subscription_events` for the Activity view. There are no table or column changes, and 0.7.0 runs unchanged against an upgraded database. Back up the database and application-data directory together before updating, as usual.
- New API endpoints: `GET /api/activity` and `POST /api/activity/read`. `GET /api/subscriptions` accepts `sort=changed|name|attention`, and `GET /api/collections` returns `activityCount` per collection.

## [0.7.0] - 2026-10-02

### Added

- Appearance setting in Settings with eight color themes, saved per account: Sentinel (the existing theme and the default), Graphite, Frost, Nebula, Ember, Daylight, Paper, and High contrast.
- Auto theme that follows the device's light or dark mode (Daylight or Sentinel) and switches immediately when the device changes.
- Theme previews in Settings. A selected theme applies immediately and reverts if it cannot be saved.
- The browser toolbar color follows the active theme. The last used theme is applied before the interface loads, so light themes do not flash dark on reload.

### Changed

- All interface colors now come from theme tokens, and translucent tints are derived with `color-mix()`. Sentinel looks the same as before.

### Upgrade notes

- Adds a `theme` column to `users` with the default `sentinel`, so existing accounts keep their current appearance.
- Theme colors use CSS `color-mix()`, which requires Chrome or Edge 111, Safari 16.2, Firefox 113, or later.

## [0.6.1] - 2026-10-01

### Changed

- Consolidated desktop navigation and collections into one 260 px sidebar, giving the Monitor workspace 244 px more horizontal space.
- Collections remain available in Settings and Administration. Selecting a collection returns directly to Monitor, while Settings and Administration stay near the bottom of the sidebar.
- Collection selection, search, filters, and pagination remain available when switching pages. Subscription requests pause outside Monitor while collection counts continue to refresh.
- Mobile pages retain bottom navigation and expose collections and the New collection action above the page content.

### Fixed

- Administration controls, mirrors, and tables fit narrower desktop widths without overflowing the page.
- Added coverage for collection navigation between Monitor, Settings, and Administration.

### Upgrade notes

- No database schema changes. Existing collections, subscriptions, account preferences, and integrations are preserved.

## [0.6.0] - 2026-09-30

### Added

- Persistent SQLite notification outbox with transactional release/event recording, leased delivery work, restart recovery, exponential retries, and Telegram rate-limit handling. Pending work does not expire; successful queue receipts are retained for seven days.
- Administration view of pending notifications, attempts, next retry time, and sanitized failure details.
- Server-side collection pagination, Unicode-aware search, unread/error filtering, total counts, and deterministic ordering. Pagination is enabled by default and can be disabled per account in Settings.
- Settings dropdown for the default entries per page, plus fast collection-page controls for 10, 20, 50, or 100 entries, saved per account, with first/previous/next/last navigation.
- Mirrored page count and first/previous/next/last controls below the subscription list, synchronized with the top navigation and hidden when pagination is disabled.
- English (default) and Russian interface languages, saved per account, including localized dates, dialogs, change history, and Telegram release messages. Release titles, phrases, and other user content remain unchanged.

### Changed

- Workspace, Subscription Inspector, Settings, Administration, authentication screens, and shared UI/formatting are separate modules; `src/App.tsx` now only coordinates authentication, routing, and the application shell.
- Backend route handlers are separated into authentication, collections, subscriptions, settings, administration, and system modules.
- Rule matches, history, and queued notifications are committed together after enrichment, eliminating the crash window between recording a release and delivering it.
- Collection activity ordering has a dedicated SQLite index. Search/filtering operates on the full collection even with pagination disabled.
- Updated transitive brace-expansion and fast-uri dependencies to resolve current dependency audit advisories.

### Delivery and upgrade notes

- Delivery is at least once, not exactly once: Telegram does not expose idempotent send keys. A crash after Telegram accepts a message but before SQLite records the receipt may cause a duplicate on retry.
- Notifications remain pending when a bot/chat is unavailable and resume after configuration is restored. Deleted subscriptions cancel their pending notifications; disabled users are not sent notifications.
- Back up the database and application-data directory together before updating. Startup adds the outbox table, activity index, and per-user language/pagination/page-size columns. Existing accounts default to English and 50 entries per page. Previously lost notifications cannot be reconstructed automatically.
- The corrected 0.6.0 release replaces the initial 25/50/100/200 page-size options with 10/20/50/100 and adds the default-size dropdown in Settings. Existing saved 25/200 preferences migrate to 20/100; 50 and 100 remain unchanged.

### Fixed

- Collection page-size controls use a label above the dropdown, aligned with the status-tab text. Page counts and arrow controls align as a group, mirrored above and below the subscriptions.
- Compact subscription columns prevent horizontal overflow at narrower desktop widths.
- Language and pagination preferences use compact, aligned 200 px dropdowns and distinct rows, with a divider separating the pagination toggle from the default page size. Labels and dropdowns stack on small screens.
- Removed redundant explanatory text from the Settings language section.
- Mobile administration headers wrap translated labels correctly; drawers render outside the animated page so navigation cannot cover their actions. Toasts do not intercept clicks.

## [0.5.6] - 2026-09-29

### Changed

- Extracted rule matching, direct-snapshot baseline decisions, workspace loading, status polling, dialogs, and icons into focused modules.
- Rule matching normalizes titles and phrases once per evaluation, reuses SQL statements, and avoids repeated array copying and rule lookups.
- Overlapping rules reuse successful detail requests within the same user, mirror, tracker, and polling run while retaining separate notifications and diagnostic observations.
- Administration counts collections and subscriptions independently using existing indexes rather than multiplying rows in a join.
- Workspace refreshes request lightweight subscription summaries; the existing full list and detail responses remain available.
- Manual rule checks evaluate only the selected subscription. Tracker-wide feed gaps remain unresolved until a full poll completes recovery for all active rules.
- Container builds now verify release metadata and run the complete backend/frontend test suite before producing the production image.

### Fixed

- Concurrent manual and scheduled direct checks share in-flight work, preventing duplicate events and notifications. Responses superseded by subscription edits are ignored.
- Shutdown cancels queued checks and waits for active scheduler work before closing the database.
- Collection changes cancel superseded requests and clear old rows; late responses and obsolete errors cannot overwrite the current workspace.
- Status refreshes use one adaptive interval and coalesce overlapping requests.
- Concurrent dialogs are queued, reset their input values, and settle pending requests on unmount.
- Updated the compatible Undici dependency and Vitest patch release to address dependency audit findings.

## [0.5.5] - 2026-09-29

### Added

- The sidebar brand mark's amber watch light sweeps across its visor while a tracker poll, an administrator Run now, or a subscription Check now is in progress. With reduced motion enabled, the visor shows a steady glow instead.
- A full-bleed maskable app icon for Android home screens. The Apple touch icon is also full-bleed, so iOS applies its own corner mask.

### Changed

- The Sentinel visor mark replaces the download-arrow icon across the web app, favicon, installable app icons, lockups, screenshots, and social preview.
- The favicon has its own navy plate, keeping it legible on light and dark browser tabs. Icon URLs are versioned so browsers and installed apps pick up the new artwork.

## [0.5.4] - 2026-09-11

### Changed

- Unread activity now uses the original yellow bell icon to the left of the subscription name, together with bold text. Read subscriptions return to their normal link or rule icon; the separate unread dot is removed.

## [0.5.3] - 2026-09-10

### Changed

- Subscription activity now uses one unread state, with a dot and stronger title text. Subscription type icons remain stable, and monitoring badges report only operational status.
- Opening subscription details marks activity read; the details retain a Mark unread action for reminders. Collection counts and the Unread filter use the same state.
- Removed the separate Updated filter, update indicators, and permanent read/unread row toggle.

### Fixed

- Opening details acknowledges and returns activity atomically so later events remain unread. Background refreshes preserve manually unread reminders.
- Existing pending update flags migrate to unread reminders without losing change history or previously unread events.

## [0.5.2] - 2026-09-09

### Added

- An account-specific Source markers setting for choosing website favicons or abbreviation badges, with favicons enabled by default.

## [0.5.1] - 2026-09-09

### Changed

- Tracker source markers now use the favicons published by Kinozal, Rutor, and RuTracker instead of generic letter badges.

## [0.5.0] - 2026-09-08

### Added

- A persistent Patchright browser inside the Torrentinel process, replacing the external FlareSolverr service and its unauthenticated browser-control port.
- Architecture-aware browser packaging with Google Chrome on `linux/amd64` and Patchright Chromium on `linux/arm64`.
- Per-user Kinozal browser profiles, browser-native login, reusable authenticated sessions, and bounded retry backoff.
- A lazy browser fallback for Rutor challenges that returns to the lower-overhead HTTP path after seeding reusable clearance cookies.
- Focused coverage for browser-session reuse, login submission, challenge handling, Rutor fallback, lifecycle cleanup, and restart recovery.

### Changed

- Docker Compose and Podman now deploy one self-contained Torrentinel container with a private virtual display and 512 MiB of shared memory.
- RuTracker detail monitoring and authenticated feed-gap recovery share serialized, persistent browser sessions.
- Browser profiles are retained with the encryption key and cover cache in the application-data volume and are included in paired backups.
- Dependency installation and production pruning no longer wait for npm audit or funding network calls during container builds.

### Removed

- The FlareSolverr client, sidecar container, private network, URL setting, timeout setting, and standalone Quadlet.

### Fixed

- Stale Chrome profile locks are removed only when their control socket is no longer active, allowing safe recovery after a container restart.
- Current Fastify URL-validation dependencies include the available schema-validation and URI-normalization security fixes.

## [0.5.0-integrated.4] - 2026-09-04

### Added

- A lazy, persistent in-container browser fallback for Rutor when its HTTP fast path receives an HTTP 403 or recognizable interactive verification page.
- Focused transport tests covering the normal HTTP path, browser fallback, clearance reuse, lifecycle cleanup, and non-challenge failures.

### Changed

- Successful Rutor browser clearance now seeds cookies and the browser user-agent back into the existing HTTP session, allowing later requests to return to the low-overhead path.
- Rutor browser resources are created only after a challenge and are closed through the standard tracker-plugin shutdown lifecycle.

### Fixed

- Dependency installation and production pruning no longer wait for npm audit or funding network calls during container builds.

## [0.5.0-integrated.3] - 2026-09-04

### Added

- Browser-native form submission for authenticated trackers without exposing a browser-control port.
- Per-user Kinozal browser profiles that retain login and challenge-clearance state across application restarts.
- A 15-minute retry backoff after a failed Kinozal browser or login attempt, preventing every rule from repeating the same blocked request.

### Changed

- Kinozal login, direct monitoring, and rule discovery now use the in-process Patchright browser instead of the plain HTTP transport.
- The experimental multi-architecture image is published separately from the stable channel as `bah0/torrentinel:v0.5.0-integrated.3`.
- Stale Chrome profile locks left by a container restart are removed only when their control socket is gone, so persistent browser sessions can restart without an unlock dialog.

### Fixed

- Kinozal requests can complete Cloudflare's interactive verification before authenticated detail and search pages are parsed.

## [0.5.0-integrated.1] - 2026-09-03

### Added

- An in-process Patchright provider with a persistent browser profile, challenge settlement, reusable clearance cookies, request cancellation, and orderly shutdown.
- Architecture-aware browser packaging: Google Chrome on `linux/amd64` and Patchright Chromium on `linux/arm64`.
- Unit coverage for browser-session reuse, challenge clearance, navigation-race recovery, and persistent-challenge failure.

### Changed

- RuTracker detail monitoring and authenticated gap recovery share one serialized browser session instead of calling a FlareSolverr API.
- Docker Compose and Podman now run one source-built Torrentinel container with a private virtual display and 512 MiB of shared memory.
- The application-data backup set now includes the persistent browser profile.

### Removed

- The FlareSolverr client, sidecar service, Quadlet, URL setting, and unauthenticated browser-control port.

### Fixed

- Updated Fastify and its URL-validation dependencies to releases containing the available fixes for current schema-validation and URI-normalization advisories.

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

[Unreleased]: https://github.com/ib0ndar/Torrentinel/compare/v0.8.0...HEAD
[0.9.0]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.9.0
[0.8.0]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.8.0
[0.7.0]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.7.0
[0.6.1]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.6.1
[0.6.0]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.6.0
[0.5.6]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.5.6
[0.5.5]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.5.5
[0.5.4]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.5.4
[0.5.3]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.5.3
[0.5.2]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.5.2
[0.5.1]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.5.1
[0.5.0]: https://github.com/ib0ndar/Torrentinel/releases/tag/v0.5.0
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
