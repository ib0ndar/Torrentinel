# Contributing to Torrentinel

Contributions are welcome when they keep Torrentinel focused on private release monitoring and change detection.

## Before opening a change

Use a GitHub issue to describe substantial features, new trackers, schema changes, or behavior that affects existing deployments. Security problems must follow [SECURITY.md](SECURITY.md) instead of the public issue tracker.

Do not include tracker credentials, session cookies, Telegram tokens, private feed URLs, copied tracker pages containing personal data, or copyrighted release material in issues, tests, or commits. Use minimal fictional fixtures.

## Development setup

Torrentinel requires Node.js 22.20 or newer.

```sh
npm ci
npm run dev:server
```

Start the web interface in another terminal:

```sh
npm run dev:web
```

Before submitting a pull request, run the same core checks as CI:

```sh
npm run check:release
npm test
npm run build
docker compose --env-file .env.example config --quiet
```

For changes to the web interface, also run the layout check:

```sh
npm run check:ui
```

It rebuilds `dist/public` when the sources are newer (or with `npm run check:ui -- --build`), starts an isolated fixture with fictional data (`scripts/ui-fixture.ts`; temporary database in the OS temp directory, sign-in `admin` / `admin`, port 9878 or `--port=<port>`), and checks every main page at 320, 390, 768, 1024, and 1440 px and in Russian at 390 px: no horizontal page overflow, a visible page heading, the mobile bottom bar clear of the last control, a collection search placeholder that fits, and no page errors, failed requests, or error notifications. Screenshots are saved to `output/ui-check/`, and the command exits non-zero when a check fails. It needs a Chromium for patchright (`npx patchright install chromium`) or an installed Chrome with `UI_CHECK_CHANNEL=chrome`; CI does not run it. Run the fixture alone with `node --import tsx scripts/ui-fixture.ts` after `npm run build`.

The test suite includes backend/database regressions and React request, timer, and dialog lifecycle tests. Container builds run release validation, tests, and typechecked production builds on the target Linux architecture. Use `npm run benchmark:refactoring` for reproducible, synthetic rule-matching and administration-query measurements; these are not end-to-end tracker timings.

## Tracker adapters

Each tracker integration declares its capabilities and implements the applicable direct, rule, authentication, parsing, and transport modules. Register new adapters in `server/trackers/index.ts` and add contract tests for every supported operation.

Keep tracker-specific behavior inside its adapter. Sanitize diagnostic messages, bound external requests with timeouts, and never log credentials or authenticated cookies.

## Pull requests

- Keep changes focused and explain user-visible behavior.
- Add or update tests for functional changes.
- Update the README, operations guide, and changelog when behavior or deployment changes.
- Preserve existing data unless an explicitly documented migration is required.
