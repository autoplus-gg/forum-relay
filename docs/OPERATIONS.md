# Operations and Recovery

## Health and logs

- `GET /health/live` verifies the Bun HTTP process.
- `GET /health/ready` verifies the database, worker lease, Discord, and GitHub boundaries.
- Logs are newline-delimited JSON on stdout.

Logs include correlation, mapping, source, destination, and operation identifiers where useful. Message bodies, authorization headers, webhook/private keys, tokens, and signed query values are redacted or never logged.

An unhealthy mapping is degraded independently; it does not stop healthy mappings.

Forum Relay performs an idempotent graceful shutdown on `SIGHUP`, `SIGINT`, `SIGQUIT`, `SIGTERM`, `SIGUSR1`, and
`SIGUSR2`. It stops workers, disconnects Discord, releases the database worker lease, and closes the database before
exiting. It also recognizes the Ctrl+C/ETX byte written to stdin by the generic Pterodactyl/Pelican Bun egg's `^^C` stop
action. `SIGKILL` cannot be intercepted by any process; after a forced kill, the lease expires automatically after 30
seconds. A replacement process waits for that expiry and claims the lease instead of remaining inactive.

## Discord commands

- `/relay status`
- `/relay doctor [mapping]`
- `/relay bootstrap preview|start|pause|resume`
- `/relay pause|resume`
- `/relay reconcile preview|start`
- `/relay failures list|retry|discard`
- `/relay close completed|not-planned|duplicate`

Bootstrap, reconciliation, and diagnostics require the configured owner, an administrator role, or Discord Administrator permission. `/relay close` also accepts mapping moderator roles and Manage Threads.

Cross-platform output always disables Discord allowed mentions and inserts a zero-width separator after GitHub-bound `@` characters.

## Durable work

Incoming webhooks/Gateway events and outgoing mutations use separate durable tables. Delivery GUIDs, source identities, operation identities, per-item partitions, dependencies, and relationship uniqueness prevent duplicate intent.

Temporary failures use bounded exponential backoff with jitter. Authentication, validation, and not-found failures dead-letter instead of retrying forever. Expired claims are reclaimed after a crash.

Successful payload bodies are redacted after the configured retention period while relationship metadata remains.

## Backups

For local SQLite:

- A copy is made before migrations when an existing database is present.
- A consistent `VACUUM INTO` backup runs daily.
- `PRAGMA integrity_check` must pass before the backup is accepted.
- The configured number of daily backups is retained; the default is seven.

Create an offline backup manually:

```sh
bun run cli -- backup
```

Mutating offline commands refuse to run while a live worker lease exists. Remote libSQL backups are provider-managed; configure provider snapshots separately.

To restore local SQLite:

1. Stop Forum Relay and verify `/health/live` is unavailable.
2. Preserve the current database separately.
3. Copy a verified backup over the configured SQLite file.
4. Start Forum Relay; migrations run automatically.
5. Run `/relay doctor` and `/relay reconcile preview`.
6. Apply reconciliation only after reviewing the plan.

## Reconciliation

Forum Relay reconciles active mappings at startup and at the configured daily interval. It also inspects failed GitHub App delivery records every five minutes by default and requests redelivery.

Reconciliation:

- imports unlinked canonical GitHub issues/comments;
- discovers missed Discord threads;
- refreshes existing content/state through idempotent events;
- marks missing GitHub sources `SOURCE_DELETED`;
- marks deleted Discord threads `MISSING`.

Deleted Discord threads are never recreated automatically. Explicit restoration belongs to an administrator workflow so intentional deletion is not silently undone.

## Relationship recovery and cleanup

Preview persisted relationship health:

```sh
bun run cli -- recovery-preview
bun run cli -- recovery-preview feedback
```

Preview mapping cleanup:

```sh
bun run cli -- mapping-cleanup feedback
```

Apply only while the bot is stopped:

```sh
bun run cli -- mapping-cleanup feedback --apply --confirm "DELETE feedback"
```

Cleanup writes a safety export under `.data/cleanup-exports` before deleting relationship and queue state. Discord/GitHub content is not deleted by this command.

## Database sensitivity

The database and backups contain:

- Discord webhook IDs and plaintext tokens;
- mirrored source bodies needed for edit reconstruction;
- user IDs/names and relationship metadata;
- attachment source/proxy URLs;
- retained webhook/job payloads.

Restrict filesystem access, encrypt storage/backups at the infrastructure layer, and never attach a real database to a public bug report.

## Incident checklist

1. Pause the affected mapping or stop the process if credentials may be exposed.
2. Rotate the Discord bot token, GitHub private key/webhook secret, and `m.ticket.pm` token as applicable.
3. Recreate mapping webhooks by removing the compromised stored webhook row while offline.
4. Inspect dead letters and structured logs without publishing payloads.
5. Restore a verified backup only if relationship state is damaged.
6. Run reconciliation preview, then apply safe repairs.
