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

## Tracker adapters

Each tracker integration declares its capabilities and implements the applicable direct, rule, authentication, parsing, and transport modules. Register new adapters in `server/trackers/index.ts` and add contract tests for every supported operation.

Keep tracker-specific behavior inside its adapter. Sanitize diagnostic messages, bound external requests with timeouts, and never log credentials or authenticated cookies.

## Pull requests

- Keep changes focused and explain user-visible behavior.
- Add or update tests for functional changes.
- Update the README, operations guide, and changelog when behavior or deployment changes.
- Preserve existing data unless an explicitly documented migration is required.
