# Security Policy

## Supported versions

Torrentinel is a pre-1.0 project. Security fixes are released for the latest published version only. Upgrade to the latest release before reporting a problem that may already be fixed.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** option on the repository's **Security** tab. Do not open a public issue for suspected vulnerabilities, exposed credentials, authentication bypasses, or weaknesses that could reveal tracker passwords, Telegram tokens, session data, or encryption keys.

Include the affected version, deployment method, reproduction steps, expected impact, and any relevant sanitized logs. Remove passwords, tokens, cookies, encryption keys, database contents, and private tracker URLs before attaching evidence.

The maintainer will acknowledge a complete report when practical, investigate it privately, and coordinate disclosure with the reporter. No guaranteed response or remediation timeline is currently offered.

## Deployment responsibilities

- Keep Torrentinel and its reverse proxy updated.
- Use HTTPS for any deployment reachable beyond a trusted local network.
- Keep FlareSolverr private; never publish its API port to the internet.
- Restrict access to the SQLite database, application-data directory, backups, and environment files.
- Back up the database and application-data directory together because encrypted integrations require the matching generated key.
