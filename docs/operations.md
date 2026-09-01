# Operating Torrentinel

This guide covers routine health checks, logs, updates, backups, restoration, troubleshooting, and removal for the three supported Linux deployment methods. Commands assume the installation paths and service names from the main README.

## Health and status

Torrentinel exposes `GET /api/health` without authentication so container and service managers can probe it. A successful response reports:

- `status`: application readiness
- `database`: database readiness
- `scheduler`: whether a poll is running, recent counters, and scheduling timestamps when available
- `telegramConfigured`: whether at least one user has configured Telegram

The response contains no passwords, tokens, cookies, encryption keys, or tracker URLs. It does reveal limited operational state. If that information should not be public, block `/api/health` at the reverse proxy and probe it only through the host or private container network.

Use the port belonging to the selected deployment:

```sh
# Native Linux or the default Docker Compose port
curl -fsS http://127.0.0.1:8080/api/health

# Supplied Podman Quadlet
curl -fsS http://127.0.0.1:8999/api/health
```

If Docker Compose uses a custom `TORRENTINEL_PORT`, substitute that host port.

Check service state with one of:

```sh
sudo systemctl status torrentinel.service --no-pager
docker compose ps
systemctl --user status torrentinel.service --no-pager
```

## Logs

Follow the application logs for the selected deployment:

```sh
sudo journalctl -u torrentinel.service -f
docker compose logs -f torrentinel
journalctl --user -u torrentinel.service -f
```

For container deployments, inspect FlareSolverr separately when RuTracker detail pages or authenticated recovery fail:

```sh
docker compose logs -f flaresolverr
journalctl --user -u torrentinel_flaresolverr.service -f
```

Sanitize output before sharing it. Remove cookies, credentials, tokens, private mirrors, and user-specific tracker URLs.

## Updating

Read [CHANGELOG.md](../CHANGELOG.md) and back up both persistent data locations before every update. Replace `vX.Y.Z` below with the selected published release.

### Native Linux

Build on the target host, or on a Linux system with the same architecture, libc, and Node.js ABI:

```sh
RELEASE=vX.Y.Z
git fetch --tags --prune
git checkout "$RELEASE"
npm ci
npm run build
npm prune --omit=dev
sudo systemctl stop torrentinel.service
sudo cp -a dist node_modules package.json package-lock.json /opt/torrentinel/
sudo systemctl start torrentinel.service
sudo systemctl status torrentinel.service --no-pager
curl -fsS http://127.0.0.1:8080/api/health
```

### Docker Compose

Checking out the release updates the image pin in `compose.yaml`:

```sh
RELEASE=vX.Y.Z
git fetch --tags --prune
git checkout "$RELEASE"
docker compose config
docker compose pull
docker compose up -d
docker compose ps
```

### Podman Quadlet

Install the updated declarative units without overwriting the local environment file:

```sh
RELEASE=vX.Y.Z
git fetch --tags --prune
git checkout "$RELEASE"
install -m 0644 \
  deploy/*.container deploy/*.network deploy/*.volume \
  "$HOME/.config/containers/systemd/"
podman pull "docker.io/bah0/torrentinel:$RELEASE"
systemctl --user daemon-reload
systemctl --user restart torrentinel.service
systemctl --user status torrentinel.service --no-pager
curl -fsS http://127.0.0.1:8999/api/health
```

## Data and backups

Torrentinel keeps its SQLite database separately from its generated encryption key and cached covers:

| Deployment | Database | Encryption key and covers |
| --- | --- | --- |
| Native Linux | `/var/lib/torrentinel/database` | `/var/lib/torrentinel/application` |
| Docker Compose | `torrentinel_db` volume | `torrentinel_app` volume |
| Podman Quadlet | `torrentinel_db` volume | `torrentinel_app` volume |

> [!IMPORTANT]
> Stop Torrentinel and back up both locations together. A database restored without its matching application-data directory cannot decrypt saved tracker credentials or Telegram tokens.

### Native Linux backup

```sh
sudo systemctl stop torrentinel.service
sudo tar -C /var/lib/torrentinel -czf \
  "$PWD/torrentinel-backup-$(date +%F).tar.gz" \
  database application
sudo systemctl start torrentinel.service
```

### Docker Compose backup

```sh
backup_dir="torrentinel-backup-$(date +%F)"
install -d -m 0700 "$backup_dir"
docker compose stop torrentinel
docker cp torrentinel:/data "$backup_dir/database"
docker cp torrentinel:/var/lib/torrentinel "$backup_dir/application"
docker compose start torrentinel
tar -czf "$backup_dir.tar.gz" "$backup_dir"
```

### Podman Quadlet backup

```sh
backup_dir="torrentinel-backup-$(date +%F)"
install -d -m 0700 "$backup_dir"
systemctl --user stop torrentinel.service
podman volume export -o "$backup_dir/database.tar" torrentinel_db
podman volume export -o "$backup_dir/application.tar" torrentinel_app
systemctl --user start torrentinel.service
tar -czf "$backup_dir.tar.gz" "$backup_dir"
```

## Restoring a backup

Restoration replaces live application data and can destroy newer records. Keep the current volumes or directories under a different name until the restored instance passes its health check and saved tracker and Telegram integrations have been verified.

1. Stop Torrentinel.
2. Preserve the current database and application-data locations.
3. Restore both locations from the same backup archive.
4. Preserve the ownership and permissions expected by the deployment method.
5. Start Torrentinel and check `/api/health`.
6. Verify a saved tracker login and Telegram integration before deleting the preserved data.

Podman volume archives created above can be loaded into empty replacement volumes with `podman volume import VOLUME ARCHIVE`. Do not import into the live volumes without first preserving and clearing their existing contents.

## Troubleshooting

- If the health request fails, run the status and log commands for the selected deployment method.
- If native startup reports a permission failure, confirm the `torrentinel` account can write to both `/var/lib/torrentinel/database` and `/var/lib/torrentinel/application`.
- If saved integrations cannot be decrypted, restore the database and application-data directory from the same backup.
- If RuTracker detail or recovery requests fail, inspect the FlareSolverr logs and confirm `FLARESOLVERR_URL` matches the private sidecar or loopback service.
- If Podman does not generate `torrentinel.service`, validate the generated unit and inspect generator errors:

  ```sh
  systemd-analyze --user --generators=true verify torrentinel.service
  ```

## Uninstalling

Back up both persistent data locations before uninstalling. The commands below stop the application but intentionally retain its data.

### Native Linux

```sh
sudo systemctl disable --now torrentinel.service
sudo rm /etc/systemd/system/torrentinel.service
sudo systemctl daemon-reload
```

After confirming the backup, remove `/opt/torrentinel`, `/etc/torrentinel`, and `/var/lib/torrentinel` with the host's normal administration process. Remove the dedicated `torrentinel` account only when no retained files use it.

### Docker Compose

Run this from the checked-out release directory:

```sh
docker compose down
```

This retains `torrentinel_db` and `torrentinel_app`. After verifying the backup, `docker compose down --volumes` also removes those named volumes.

### Podman Quadlet

```sh
systemctl --user disable --now torrentinel.service
```

Remove the Torrentinel `.container`, `.network`, and `.volume` files from `~/.config/containers/systemd`, then run `systemctl --user daemon-reload`. Retain `torrentinel_db` and `torrentinel_app` until the backup has been verified; remove them with `podman volume rm` only when their exact names have been confirmed with `podman volume ls`.
