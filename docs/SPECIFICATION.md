# Forum Relay Functional Specification

## 1. Purpose

Forum Relay is a privately operated, open-source Discord bot and GitHub App that synchronizes one Discord Forum channel with one GitHub repository's Issues in both directions.

Discord users can create and discuss suggestions without GitHub accounts. GitHub Issues remain the canonical record after bootstrap.

The project source is public-facing software, but AutoPlus.gg does not provide a public hosted Discord bot or shared GitHub App. Every operator creates and controls their own Discord application, GitHub App, database, and deployment.

## 2. Supported scope

- Runtime: Bun only.
- Discord: one guild per deployment; Discord Forum channels only.
- GitHub: GitHub.com Issues only.
- One deployment may contain multiple independent forum/repository mappings.
- One forum and one repository may each belong to only one mapping.
- Public and private GitHub repositories are supported when the GitHub App is installed on them.
- Local SQLite is the default database; libSQL-compatible URLs are supported.
- English is the only bot-authored interface language in v1.

## 3. Explicit non-goals

- A publicly hosted bot, shared GitHub App, or SaaS offering.
- GitHub Enterprise Server.
- Discord Media channels.
- GitHub Pull Requests or Discussions.
- A web administration dashboard.
- User OAuth or Discord-to-GitHub account linking.
- Reactions or vote synchronization.
- GitHub Projects, milestones, assignees, issue types, sub-issues, dependencies, or pinned-item synchronization. Their
  GitHub activity may be logged into Discord, but Forum Relay does not synchronize or mutate those resources.
- Running or validating GitHub Issue Forms from Discord.
- Telemetry, analytics, crash reporting, or update checks.
- Profanity, spam, or policy filtering.
- Node.js runtime compatibility.

## 4. Terminology

- **Mapping:** A stable, configured one-to-one relationship between a Discord Forum channel and a GitHub repository.
- **Relay item:** One logical issue body, comment, Discord starter, reply, or lifecycle notice.
- **Segment:** One of several Discord webhook messages required to represent a relay item that exceeds Discord limits.
- **Mirror:** The destination representation of canonical source content.
- **Operation ledger:** Durable records of Forum Relay's own platform mutations, used to suppress loops and classify events.
- **Suppressed mirror:** A destination mirror intentionally deleted by a moderator and therefore not automatically recreated.
- **Revision shadow:** A webhook-authored Discord message showing GitHub's canonical revision when Forum Relay cannot edit the original human-authored Discord message.

## 5. Configuration authority

`config/config.ts` is the desired configuration source. It defines the guild, administrators, mappings, label/tag aliases, bootstrap direction and filters, logging, presence, and maintenance defaults.

- Configuration changes require a restart.
- Discord commands cannot create or permanently reconfigure mappings.
- The mapping key is its immutable internal identity.
- Changing the repository or forum of an initialized mapping is rejected.
- Removing a mapping disables it while preserving its database state.
- Permanent mapping cleanup is an explicit offline CLI action.
- Supported older config versions are normalized through typed migrations.
- Startup never rewrites `config.ts`.

The database stores resolved platform IDs, synchronization state, content hashes, operation state, bootstrap progress, cursors, suppression state, and message relationships.

## 6. Mapping lifecycle

A mapping uses these operational states:

- `PENDING_BOOTSTRAP`
- `MIGRATING`
- `ACTIVE`
- `PAUSED`
- `DEGRADED`
- `DEGRADED_READ_ONLY`
- `DISABLED`

An invalid mapping does not prevent healthy mappings from operating. Missing global credentials, an invalid config version, database migration failure, or failure to acquire required global resources prevents the worker from becoming ready.

Examples of mapping-local degradation include:

- GitHub App not installed on the configured repository.
- Discord permissions missing in the mapped forum.
- View Audit Log unavailable.
- Bot-owned webhook missing and replacement failing.
- Repository write access removed.
- Repository archived or Issues disabled.

## 7. Bootstrap

### 7.1 Safety

A new mapping does not import history automatically at process startup.

1. The mapping enters `PENDING_BOOTSTRAP`.
2. `/relay bootstrap preview` inspects both platforms.
3. The preview reports counts, filters, labels/tags, ambiguous states, notification limitations, and blockers.
4. A configured owner or bot administrator starts the import explicitly.
5. The selected source is snapshotted.
6. Live events begin entering the durable inbox.
7. Historical content imports oldest-first.
8. Canonical state is applied after content.
9. Queued events are drained, deduplicated, and re-fetched where necessary.
10. The mapping becomes `ACTIVE`.

The intended target must contain no issues or forum posts. Existing label and tag definitions are allowed and resolved during preview. If both sides contain content, v1 refuses automatic merging or heuristic pairing.

Bootstrap may be paused and resumed. It cannot be automatically rolled back. Destructive cleanup requires the offline CLI, a preview, the mapping key, and an explicit confirmation phrase.

### 7.2 GitHub to Discord

Available filters:

- `all`
- `open-only`
- Optional `createdAfter`

Pull Requests returned through issue APIs are always excluded.

`open-only` is an initial-bootstrap filter:

- Previously closed issues remain absent while closed.
- If a skipped issue is reopened later, its full body and comment history are imported once.
- Issues created after the bootstrap snapshot synchronize normally.

### 7.3 Discord to GitHub

Available filters:

- `all`
- `active-only`
- Optional `createdAfter`

`active-only` means currently visible/active Discord threads; it does not claim to identify semantic closure.

For historical thread state:

- Locked threads import as closed and locked.
- Archived but unlocked threads import as open unless a matching audit entry proves a manual close.
- Ambiguous threads are reported in preview.
- Per-thread state overrides may be configured.

Discord history is imported oldest-first. GitHub creation timestamps cannot be backdated, so attribution records the original Discord timestamp.

GitHub's create-issue and create-comment APIs trigger notifications and provide no suppression option. The preview must warn that repository watchers may be notified. Imports are throttled to respect secondary rate limits.

## 8. Canonical authority and conflict handling

After bootstrap, GitHub is canonical.

Processing is serialized per issue/thread while unrelated items may run concurrently.

Before applying a Discord-origin edit to GitHub:

1. Re-fetch the GitHub item.
2. Compare its stored canonical version/hash and operation markers.
3. Apply the Discord edit only if GitHub has not independently changed.
4. If GitHub changed independently, keep GitHub's revision.
5. Update or create the Discord revision shadow.
6. Notify the affected Discord thread and operational log without pinging the author.

Forum Relay's own delayed webhook events are recognized through both App identity and durable operation markers; they are not treated as human conflicts.

## 9. Creation and attribution

### 9.1 GitHub to Discord

A GitHub issue becomes a Discord forum thread:

- Thread name mirrors the GitHub title, truncated by Unicode grapheme to Discord's 100-character limit.
- The complete GitHub title remains stored.
- The first message represents the issue body.
- Comments become ordered relay items in the same thread.
- The dedicated mapping webhook uses the GitHub author's login and avatar per message.
- The final segment contains the canonical GitHub jump link.

The thread name contains no issue-number prefix. Issue identity appears in the starter content and links.

### 9.2 Discord to GitHub

A human-created forum post becomes a GitHub issue created by the GitHub App. The body uses a fixed, versioned format rather than a configurable template:

```md
<!-- forum-relay:v1 source=discord message=DISCORD_MESSAGE_ID -->
<img src="DISCORD_AVATAR_URL" width="24" height="24" alt=""> **DISPLAY NAME**
`@username` · Discord user `USER_ID`

MESSAGE CONTENT

ATTACHMENTS

[Jump to the original Discord message](https://discord.com/channels/GUILD_ID/THREAD_ID/MESSAGE_ID)
```

Rules:

- Snapshot display name, username, and avatar at creation.
- Escape every user-controlled attribution field.
- Use the default Discord avatar when necessary.
- Strip relay-marker text supplied by users before adding the App-owned marker.
- Include the original timestamp for historical or materially delayed content.
- Use the same attribution structure for Discord replies mirrored as GitHub comments.

Forum Relay imports human-authored Discord messages only. It ignores its own bot, its own webhooks, all other bots, all other webhooks, system messages, commands, and component interactions unless explicitly handled as lifecycle state.

GitHub-authored bot/App comments are mirrored except Forum Relay's own marked Discord-origin content.

## 10. Titles

- GitHub title edits rename the Discord thread.
- Authorized Discord thread renames update the GitHub issue title.
- The thread author may rename their own open thread.
- Mapping moderators may rename any mapped thread.
- GitHub titles longer than 100 Discord characters are truncated for display only.
- An intentional later Discord rename replaces the complete GitHub title; it is not combined with the previously stored suffix.
- Operation-ledger entries suppress rename loops.

## 11. Labels and forum tags

GitHub label definitions are discovered automatically; configuration contains no label/tag mapping.

- Store resolved GitHub label IDs and Discord tag IDs in the database.
- GitHub owns label identity and existence; Discord owns the display name of an already-paired tag.
- GitHub labels of at most 20 characters use the same Discord tag name.
- Longer names receive a deterministic shortened name consisting of a readable prefix and the complete base-36 GitHub label ID.
- Labels are ordered case-insensitively by name, with immutable ID as the tie-breaker.
- Existing case-insensitive Discord tags are reused and retain their emoji and moderation setting.
- Discord-only tags remain Discord-only and are ignored.
- For a Discord-source first bootstrap only, existing forum tags create missing same-name GitHub labels before content is imported.
- The first five applied labels with resolved tags become Discord tags; overflow remains GitHub-only.
- GitHub label creation creates a paired Discord tag. A later GitHub label rename keeps the existing Discord tag ID and display name.
- Renaming a paired Discord tag is persistent and never changes GitHub. Deleting it recreates a tag from the current GitHub label name and stores the replacement ID.
- Deleting a GitHub label removes its paired Discord tag.
- A forum can expose at most 20 tags. Labels beyond remaining capacity stay `PARTIAL`, remain GitHub-only on Discord threads, and emit an operator warning.

Applied tag changes from Discord require Manage Threads or a configured mapping moderator role. GitHub-side label permissions remain enforced by GitHub.

## 11.1 GitHub activity timeline

GitHub issue lifecycle activity is mirrored into the linked Discord thread as compact, non-notifying webhook messages.
The GitHub actor name links to that actor's GitHub profile. Supported real-time activity includes:

- label, assignee, milestone, issue type, pin, title, close/reopen, and lock/unlock changes;
- sub-issue and dependency changes;
- adding/removing an issue from an organization Project;
- Project field changes, including Status moves, plus archive, restore, and reorder activity.

Project activity requires read-only organization Projects permission and the `Projects v2 item` webhook subscription.
This is observability only; GitHub remains authoritative and Forum Relay never changes Project state. Existing timeline
history is not replayed when this capability is enabled. GitHub timeline rows for which GitHub exposes no App webhook,
such as some mention and cross-reference rows, are not mirrored in real time.

## 12. Message edits and revision shadows

Every logical relay item has source/destination records and one or more ordered Discord segment records.

- Editing GitHub-native content re-renders its Discord webhook segments.
- Editing Discord-native content updates the App-created GitHub issue body or comment.
- Re-rendering retains reusable segment IDs, creates additional segments, and deletes surplus segments.
- No edit silently truncates content.

Forum Relay cannot edit a human Discord message. If GitHub canonical content diverges from a Discord-origin message:

- Keep the original human message.
- Create or update one webhook-authored “Updated on GitHub” revision shadow after it.
- Store the original and shadow IDs.
- If the Discord author later edits the original, that revision becomes canonical on GitHub and the shadow is deleted.

## 13. Deletions and suppression

### 13.1 Individual relay items

- Deleting a Discord-origin reply deletes its App-created GitHub comment.
- Deleting a GitHub-native comment deletes every Discord webhook segment for that comment.
- Manually deleting any Discord segment of a GitHub-native logical item suppresses the whole mirror, removes remaining segments, and never deletes GitHub content.
- Reconciliation and later edits do not recreate suppressed mirrors.
- Administrators may restore a suppressed item explicitly.

### 13.2 Starter bodies

- A starter-message deletion never escalates into deleting the GitHub issue.
- If Discord exposes starter deletion without thread deletion, the GitHub body becomes an attributed tombstone.
- If a GitHub issue body is emptied, the Discord starter becomes an “issue description removed on GitHub” tombstone.

### 13.3 Whole threads and issues

- Deleting a Discord thread never deletes its GitHub issue.
- The mapping becomes `MISSING`; automatic recreation is disabled.
- Administrators may restore a new thread from GitHub.
- Historical Discord URLs remain stored even when broken.

If a whole GitHub issue is deleted:

- Post a canonical-source-deleted lifecycle notice.
- Close and lock the Discord thread.
- Mark it `SOURCE_DELETED`.
- Stop synchronization for that item.
- Preserve the Discord discussion for manual recovery or deletion.

## 14. Markdown and Components V2

GitHub-to-Discord messages use Components V2 without a Container.

The renderer emits an ordered top-level stream such as:

1. Text Display
2. Media Gallery
3. Text Display
4. File
5. Text Display containing the final jump link

Sections, separators, thumbnails, and other Components V2 elements may be used where they improve fidelity, but a wrapping Container is prohibited.

The renderer uses a Markdown AST, not regex-only parsing.

Supported transformations include:

- Headings, paragraphs, lists, blockquotes, emphasis, links, inline code, and fenced code.
- GFM task lists as Unicode checkboxes.
- GitHub alerts as styled blockquotes.
- Tables as fenced monospace representations.
- Repository-relative links and images.
- Same-repository `#issue`, cross-repository issue, and commit references.
- Markdown images and sanitized HTML `<img>` elements through one in-order media pipeline.
- Consecutive images grouped into a Media Gallery.
- `<details>` summary and content rendered visibly.
- Math and Mermaid preserved as fenced source with a GitHub jump link.
- Relay HTML comments stripped.
- Other raw HTML sanitized while preserving readable text.

Forum Relay never uses GitHub's rendered HTML as trusted output.

### 14.1 Segmentation

One logical relay item may become multiple webhook messages.

- Split on Markdown-aware block boundaries first.
- Preserve paragraphs, lists, links, and fenced code where possible.
- Fall back through line, word, and grapheme boundaries.
- Repeat webhook author identity on every segment.
- Put the jump link on the final segment only.
- Store render version and ordered segment IDs.

## 15. Attachments and media

### 15.1 Discord to GitHub

Discord attachments are uploaded through the `m.ticket.pm` v2 attachment API using one long-lived
`TicketPmMediaProxyClient`. Anonymous operation is the default; an optional token may be supplied for bearer
authentication.

- Store and reuse returned hashes.
- Store source attachment identity, hash, and resulting URL.
- Media bytes are immutable and have no deletion endpoint.
- Deleting or editing content removes references but does not delete stored bytes.
- This behavior is documented during setup.

Attachment failure does not block surrounding text:

- Insert an in-order “attachment is being proxied” placeholder.
- Queue each upload independently.
- Edit the GitHub body/comment when the durable URL becomes available.
- Retry temporary failures and rate limits.
- Replace permanent failures with an unavailable notice and Discord jump link.
- Never omit an attachment silently.

Voice messages become linked/playable audio. Stickers become image/name representations.

### 15.2 GitHub to Discord

- Parse both Markdown image syntax and sanitized HTML `<img>`.
- Fetch only recognized GitHub-hosted attachment/content domains.
- Revalidate protocol, DNS results, redirects, MIME type, and byte limits at every hop.
- Authenticate private-repository fetches through the installation token.
- Upload directly through the Discord webhook when within the guild upload limit.
- Oversized files become labeled GitHub download links with filename and size.
- Private-repository fallback links explain that GitHub access is required.
- Arbitrary external images are links and are never fetched server-side.
- Forum Relay's public HTTP server never acts as a private GitHub file host.

## 16. Mentions and special Discord message types

Cross-platform mentions never notify.

GitHub to Discord:

- Always use `allowed_mentions: { parse: [] }`, including edits.
- Render GitHub mentions readably without Discord pings.

Discord to GitHub:

- User mentions become readable Discord user links, not GitHub mentions.
- Role and channel mentions become escaped readable labels; channels may link to Discord.
- `@everyone` and `@here` are neutralized.
- Custom emoji become a small image or `:name:` fallback.
- Discord timestamps become ISO timestamps.
- Mention conversion does not occur inside code.

Special message handling:

- Replies include a compact “Replying to…” author and source jump link; GitHub remains flat.
- Voice messages include audio.
- Stickers include their image and name.
- Forwarded snapshots are clearly marked and are not recursively relayed.
- Polls become a static question/options snapshot with a Discord voting link; votes do not synchronize.
- Automatic link-preview embeds are ignored.
- Unsupported future message types create a warning and a fallback source link.

## 17. Open, close, lock, and inactivity state

Discord's API `archived` flag represents both inactivity hiding and manual closing. It is not equivalent to GitHub closure without context.

- GitHub close archives the Discord thread.
- GitHub reopen unarchives it.
- GitHub lock locks the Discord thread.
- GitHub unlock unlocks it while preserving open/closed state.
- A native Discord close defaults to GitHub's `completed` state reason.
- Native Discord lock locks GitHub without a lock reason.
- `/relay close` supports `completed`, `not-planned`, and `duplicate`.
- Duplicate targets may be a same-repository issue number/URL or mapped Discord thread.
- Duplicate lifecycle messages link the GitHub issue and mapped Discord target when available.

Forum Relay does not run a keepalive scheduler. Normal inactivity hiding is allowed.

To classify Discord state:

1. Suppress changes matching the operation ledger.
2. Delay unexplained changes briefly.
3. Query the audit log more than once.
4. Correlate thread ID, action, timestamp, and actor.
5. Treat close without audit evidence as inactivity hiding.
6. Treat an automatic reopen accompanied by a human message as a user reopen.
7. Leave GitHub unchanged when evidence remains ambiguous and retry during reconciliation.

A Discord user posting in a closed but unlocked thread reopens the GitHub issue before relaying the comment.

A GitHub comment on a closed issue does not reopen GitHub. Forum Relay temporarily unarchives the Discord thread, posts the mirror, and archives it again using operation-ledger suppression.

Locked items reject comments.

## 18. Lifecycle attribution

Public lifecycle notices are sent before a final lock where possible.

Examples:

- “Closed by X — marked as completed on GitHub”
- “Closed by X — marked as not planned on GitHub”
- “Closed by X — marked as duplicate of …”
- “Locked by X — resolved”
- “Reopened by X”

GitHub-origin notices use the GitHub actor's webhook identity.

Discord-origin close, reopen, lock, and unlock actions add a compact, Discord-attributed GitHub comment before the App performs the state mutation. Label changes do not create comments.

GitHub lock reasons supported when provided:

- `off-topic`
- `too heated`
- `resolved`
- `spam`

Discord has no “Lock as…” UI in v1.

## 19. Repository and comment edge cases

### 19.1 Repository rename or transfer

The immutable GitHub repository ID is canonical.

- Continue following a rename/transfer when the ID is unchanged and App access remains.
- Use the new canonical name in generated links.
- Report config drift until config is updated.
- Become degraded if App access is lost.

### 19.2 Issue transfer

When an issue transfers to another repository:

- Mark the old thread `TRANSFERRED_OUT`.
- Post the destination link, then close and lock the old thread.
- If the destination repository has a configured mapping, create a new thread there and cross-link both threads.
- Continue synchronization through the destination mapping.
- Otherwise stop after linking the new GitHub location.

### 19.3 Minimized comments

- Replace a minimized GitHub comment's Discord mirror with a hidden-on-GitHub notice and reason when available.
- Retain the GitHub jump link.
- Restore content when unminimized.
- Discord cannot minimize GitHub comments in v1.

### 19.4 Issue Forms

GitHub-to-Discord renders the Markdown body produced by an Issue Form.

Discord-to-GitHub does not execute, validate, or synthesize repository Issue Forms. Forum tags map only to configured labels.

## 20. Authorization

### 20.1 Owner

The configured `ownerId` may perform all operations, including bootstrap, destructive cleanup authorization, and global recovery.

### 20.2 Bot administrators

Configured administrator roles may:

- Preview/start/pause/resume bootstrap.
- Pause/resume mappings.
- Run reconciliation.
- Inspect/retry/discard dead letters.
- Restore missing/suppressed mirrors.

Discord Administrator does not silently grant Forum Relay global administration.

### 20.3 Mapping moderators

Users with Manage Threads or a configured mapping moderator role may:

- Close/reopen.
- Lock/unlock.
- Use `/relay close`.
- Change synchronized tags.
- Rename mapped threads.

### 20.4 Regular users

Users with normal forum access may create threads, reply, and edit/delete their own Discord-origin messages. GitHub permissions remain GitHub-controlled.

## 21. Discord and GitHub permissions

Discord permissions:

- View Channels
- Send Messages
- Send Messages in Threads
- Create Public Threads
- Read Message History
- Attach Files
- Embed Links
- Manage Threads
- Manage Channels
- Manage Webhooks
- View Audit Log

Discord Gateway intents:

- Guilds
- Guild Messages
- Message Content

GitHub repository permissions:

- Issues: read and write
- Contents: read
- Metadata: read

Optional GitHub organization permissions:

- Projects: read

GitHub webhook subscriptions:

- Issues
- Issue comments
- Issue dependencies
- Labels
- Repository changes
- Sub issues
- Projects v2 item (when organization Projects permission is enabled)
- Installation changes
- Installation repository changes

## 22. Discord webhook ownership

Each mapping owns exactly one dedicated incoming webhook in its forum.

- Forum Relay creates it when missing.
- Store its ID and token in plaintext in the database.
- Never adopt or modify unrelated webhooks.
- Confirm its forum and application ownership at startup.
- Recreate it if an administrator deletes it.
- Treat the database and backups as sensitive because they contain webhook tokens.
- Never include tokens in logs or diagnostic exports.

## 23. Reliability and delivery

Forum Relay uses durable at-least-once processing with effectively-once outcomes:

- Persist inbound events before processing.
- Persist outbound intent before external calls.
- Use stable idempotency keys.
- Serialize operations per issue/thread.
- Retry temporary errors with exponential backoff and jitter.
- Respect Discord rate limits, GitHub primary/secondary rate limits, and `m.ticket.pm` `Retry-After`.
- Move permanent or exhausted failures to a dead-letter state.
- Never drop content silently.

Backpressure rules:

- Preserve creates and deletes.
- Coalesce pending edits to the newest revision.
- Coalesce undelivered reversible state transitions.
- Pause processing before disk exhaustion and report degradation.

When synchronization is delayed, maintain one bot-managed thread notice rather than repeating warnings. Remove it after recovery.

## 24. Webhooks, Gateway, and reconciliation

### 24.1 GitHub webhook server

`Bun.serve` exposes:

- `POST /webhooks/github`
- `GET /health/live`
- `GET /health/ready`

Webhook handling:

- Enforce method, content type, and raw-body size limit.
- Verify `X-Hub-Signature-256` against the raw body before parsing.
- Deduplicate `X-GitHub-Delivery`.
- Persist accepted events before returning success.
- Process asynchronously.
- Return failure when verification or persistence fails.
- Ignore events from unconfigured repositories after safe validation/classification.

Health endpoints expose no sensitive configuration.

GitHub does not automatically retry failed webhook deliveries. Every five minutes and at startup, Forum Relay inspects the GitHub App delivery log and requests redelivery of failed deliveries within GitHub's available redelivery window. Delivery GUIDs remain deduplicated.

### 24.2 Discord Gateway

The Gateway is the primary Discord event source. On startup or reconnect, Forum Relay scans active forum threads and latest message IDs to recover missed events.

### 24.3 Reconciliation

- Targeted reconciliation follows ambiguous events, failed operations, or administrator requests.
- A full integrity reconciliation runs every 24 hours by default.
- Full reconciliation compares relationships, titles, canonical state, locks, configured labels/tags, segment records, missing counterparts, and suppression state.
- Suppressed mirrors are never recreated automatically.

## 25. Single-worker lease

Exactly one active Forum Relay worker may use a database.

- Acquire and renew a database lease before connecting the Gateway or processing jobs.
- A second process may expose liveness but remains unready.
- Loss of the lease stops processing and Gateway activity safely.
- This prevents competing migration workers and duplicate Discord consumers.

## 26. Retention, backups, and recovery

Persistent relationship records include IDs, hashes, author snapshots, render versions, timestamps, and state—not a permanent third content archive.

- Pending and failed payloads retain required content.
- Successful payload bodies and operation history are redacted after 30 days by default.
- Dead-letter payloads remain until retry or explicit discard.
- Local SQLite receives a consistent daily backup and a backup before schema migration.
- Keep seven local backups by default in `.data/backups`.
- Remote libSQL backup durability is provider-managed.

Recovery scanning is dry-run first and reconstructs relationships from:

- Forum Relay markers in GitHub content created from Discord.
- GitHub jump links in Discord webhook messages.
- Discord IDs and links stored in GitHub attribution.

No extra GitHub comments or body mutations exist solely for recovery.

## 27. Administration

Discord commands are ephemeral unless producing an intentional public lifecycle notice.

- `/relay status [mapping]`
- `/relay doctor [mapping]`
- `/relay bootstrap preview|start|pause|resume`
- `/relay pause|resume`
- `/relay reconcile preview|start`
- `/relay failures list|retry|discard`
- `/relay restore thread|item`
- `/relay close completed|not-planned|duplicate`

Long previews and diagnostics may be ephemeral file attachments.

Offline CLI responsibilities:

- Config migration
- Database backup/restore
- Recovery preview/apply
- Mapping cleanup preview/apply

Mutating CLI actions refuse to run while the worker lease is active. Read-only previews may run concurrently.

## 28. Operational logging

- Structured stdout logs are mandatory.
- An optional Discord log channel receives important administrative events.
- Log bootstrap state, mapping degradation, dead letters, repairs, state actions, webhook replacement, and permission/config errors.
- Do not log ordinary message bodies.
- Include mapping key, source/destination IDs, actor ID when available, and operation/correlation ID.
- Redact secrets and signed URLs.

## 29. Testing and CI

Vitest runs under Bun:

```sh
bun --bun vitest
```

GitHub Actions requires:

- TypeScript typecheck
- Biome
- Drizzle schema validation
- Vitest unit/fixture/database tests
- Production build

The synchronization domain enforces 90% line and branch coverage. Thin external adapters and startup wiring are excluded from the threshold.

Tests include:

- Markdown AST rendering and segmentation.
- Mention and URL sanitization.
- Label/tag limits and priority.
- State-transition tables.
- Real sanitized Discord and GitHub webhook fixtures.
- Inbox/outbox deduplication and retries.
- Edit conflicts and revision shadows.
- Reconciliation and crash recovery.
- Database lease behavior.

## 30. Acceptance criteria

Forum Relay v1 is complete when:

1. Both bootstrap directions are resumable and pass the empty-target safety checks.
2. New issues/posts and comments/messages synchronize bidirectionally.
3. Edits, deletions, suppressions, revision shadows, titles, configured labels/tags, close reasons, locks, and transfers follow this specification.
4. Markdown, Components V2, attachments, and special Discord message types degrade without silent loss.
5. Every cross-platform mention is non-notifying.
6. Duplicate and delayed events cannot create duplicate issues, comments, threads, or messages.
7. Startup/reconnect recovery and full reconciliation repair missed events without recreating suppressed content.
8. A failed mapping cannot stop healthy mappings.
9. Backups, dead-letter operations, recovery previews, and administrator diagnostics function.
10. CI and coverage requirements pass under Bun.
