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
- Restrict access to the SQLite database, application-data directory, integrated-browser profile, backups, and environment files. Browser profiles can contain reusable challenge-clearance cookies.
- Do not add a public debugging or browser-control port; the integrated browser requires no inbound network access.
- Keep Chrome's sandbox available to the integrated browser: use the supplied seccomp profile with Docker (Podman's default profile already allows it; see "Integrated browser sandbox" in the README) and watch the log for a warning that it is unavailable.
- Behind a reverse proxy, set `TRUST_PROXY` to the proxy's address so sign-in attempt limits apply to each client, and send `Strict-Transport-Security` from the proxy.
- Grant administrator rights only to people trusted with the whole installation. Administrators control the global tracker mirrors that every account's tracker logins are sent to, and can see all accounts' tracker activity in Diagnostics.
- Back up the database and application-data directory together because encrypted integrations require the matching generated key.
