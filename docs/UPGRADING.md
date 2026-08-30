# Upgrading Forum Relay

Forum Relay runs database migrations during startup. Upgrades should still be treated as stateful operations because the
database contains durable relay relationships that cannot be reconstructed perfectly from either platform alone.

## Before upgrading

1. Read the target release notes for configuration or permission changes.
2. Stop Forum Relay cleanly so no worker owns the database lease.
3. Back up `config/`, `.data/forum-relay.db`, and the existing deployment artifact or container image.
4. Verify that the backup is stored separately from the deployment directory.

## Native Bun deployment

```sh
git fetch --tags
git checkout VERSION
bun install --frozen-lockfile
bun run check
bun run start
```

Replace `VERSION` with the release tag being installed. Startup creates a pre-migration database backup before applying
pending schema migrations.

## Docker Compose deployment

```sh
git fetch --tags
git checkout VERSION
docker compose build --pull
docker compose up -d
```

Do not delete or recreate the `.data` volume during an ordinary upgrade.

## After upgrading

1. Check startup logs for migration, lease, Discord, GitHub, and webhook validation failures.
2. Confirm `GET /health/ready` returns HTTP 200.
3. Run `/relay doctor` and review any mapping or durable-work warnings.
4. Test one non-production issue/thread pair before relying on new synchronization behavior.

## Rollback

Stop the new version, restore the previous application version and its matching pre-upgrade database backup, then start the
previous version. Do not run two versions against the same database.
