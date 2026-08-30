# Forum Relay Configuration Reference

## 1. Configuration model

Forum Relay separates:

- **Non-secret desired state** in `config/config.ts`
- **Credentials and deployment values** in environment variables or secret files
- **Resolved IDs and operational state** in the database

`config/config.ts` is imported once at startup. Changes require a restart.

Copy the tracked examples before first startup:

```sh
cp config/config.example.ts config/config.ts
cp config/example.env config/.env
```

Both local files are ignored by Git.

## 2. Example

```ts
import { defineConfig } from "@/config/index.js";

export default defineConfig("0.0.1", {
	clientId: "123456789012345678",
	guildId: "123456789012345678",
	ownerId: "123456789012345678",
	administratorRoleIds: ["123456789012345678"],
	logChannelId: "123456789012345678",
	publicBaseUrl: "http://relay.example.com:3000",

	status: {
		enabled: true,
		text: "Syncing Discord forums with GitHub Issues",
		type: "WATCHING",
		status: "online"
	},

	maintenance: {
		failedWebhookDeliveryCheckMinutes: 5,
		fullReconciliationIntervalHours: 24,
		localBackupCount: 7,
		processedPayloadRetentionDays: 30
	},

	mappings: {
		feedback: {
			forumChannelId: "123456789012345678",
			repository: {
				owner: "example-org",
				name: "feedback"
			},
			moderatorRoleIds: ["123456789012345678"],
			bootstrap: {
				source: "github",
				issueFilter: "open-only"
			}
		}
	}
});
```

## 3. Global fields

### `version`

Added by `defineConfig`. The version selects an exact TypeScript interface and runtime normalization path.

Rules:

- Supported older versions normalize to the current internal model.
- Deprecated versions produce a warning.
- Unsupported/newer versions fail startup.
- Runtime startup never edits the config.
- The CLI migration command writes a new file beside the original.

### `clientId`

Discord application ID. It is not the bot token.

### `guildId`

The only Discord guild served by this deployment. All configured forums, roles, and optional log channels must belong to this guild.

### `ownerId`

Discord user ID with unrestricted Forum Relay administration.

### `administratorRoleIds`

Discord role IDs allowed to run global operational commands such as bootstrap, reconciliation, pause/resume, dead-letter management, and restoration.

Discord's Administrator permission does not replace this list.

### `logChannelId`

Optional Discord channel receiving operational events. It must be accessible to the bot and should be private to operators.

Ordinary synchronized message bodies are never copied there.

### `publicBaseUrl`

Public HTTP or HTTPS origin routed to Forum Relay, without a trailing path:

```text
http://relay.example.com:3000
```

The GitHub App webhook URL becomes:

```text
http://relay.example.com:3000/webhooks/github
```

Both HTTP and HTTPS are accepted. The origin must be reachable by GitHub; a private LAN or loopback address will not work
unless a tunnel forwards traffic to it. Every delivery is still authenticated using the mandatory webhook HMAC secret.
HTTPS remains optional for operators who want transport encryption.

## 4. Presence

`status` is optional.

```ts
status: {
	enabled: true,
	text: "Syncing Discord forums with GitHub Issues",
	type: "WATCHING",
	status: "online"
}
```

Activity types:

- `PLAYING`
- `STREAMING`
- `LISTENING`
- `WATCHING`
- `CUSTOM`
- `COMPETING`

Presence states:

- `online`
- `idle`
- `dnd`
- `invisible`

`url` applies only to `STREAMING`.

## 5. Maintenance

All maintenance fields are optional; omitted values use documented defaults.

### `failedWebhookDeliveryCheckMinutes`

- Default: `5`
- Checks GitHub App webhook-delivery status and requests redelivery of failures.
- This does not poll issue content.

### `fullReconciliationIntervalHours`

- Default: `24`
- Runs a complete mapping integrity comparison.

### `localBackupCount`

- Default: `7`
- Number of verified local SQLite backups retained.
- Does not apply to remote libSQL.

### `processedPayloadRetentionDays`

- Default: `30`
- Successful inbox/outbox payload bodies are redacted after this period.
- Relationship metadata remains.
- Dead-letter payloads are retained until retry/discard.

Runtime validation rejects zero, negative, non-finite, or unreasonable maintenance values.

## 6. Mappings

`mappings` is a record keyed by an immutable operator-selected identifier:

```ts
mappings: {
	feedback: {
		// ...
	}
}
```

The key:

- Appears in commands and logs.
- Becomes the permanent database identity.
- Must not be renamed after initialization.
- Must use a conservative identifier format such as lowercase letters, numbers, `_`, and `-`.

One forum/repository pair per key is allowed. A forum or immutable repository ID may not appear in another active mapping.

### `forumChannelId`

Discord Forum channel ID. Media channels and ordinary text channels fail validation.

### `repository`

GitHub.com repository locator:

```ts
repository: {
	owner: "example-org",
	name: "feedback"
}
```

The locator resolves to and persists GitHub's immutable repository ID.

Renames/transfers with the same ID continue operating while config drift is reported. Changing the configured locator to a different immutable repository ID is rejected for an initialized mapping.

### `moderatorRoleIds`

Roles with mapping-local lifecycle/tag permissions. Users with Manage Threads also qualify for mapping-local actions.

### Labels and forum tags

There is no label mapping field. GitHub is the source of truth and repository labels are discovered automatically.

- Names of at most 20 characters are reused directly.
- Longer names receive a deterministic shortened Discord name containing the immutable GitHub label ID.
- Existing same-name Discord tags are reused, including their emoji and moderation setting.
- After pairing, Discord tag names may be customized independently; GitHub label renames retain the paired tag ID and its Discord name.
- Deleting a GitHub label removes its paired Discord tag. Deleting the Discord tag recreates it from the current GitHub label name.
- Discord-only tags remain Discord-only.
- Before a Discord-source first bootstrap, existing forum tags seed same-name GitHub labels automatically.
- Labels are ordered deterministically by name. Discord exposes at most 20 forum tags and applies at most five to a thread; definitions beyond available capacity remain GitHub-only and are reported in logs.

There is no GitHub issue-body template field. Discord-origin issues use Forum Relay's fixed, versioned attribution format. Repository Issue Forms are not projected into Discord.

## 7. Bootstrap configuration

Bootstrap configuration is a discriminated union.

### GitHub source

```ts
bootstrap: {
	source: "github",
	issueFilter: "open-only",
	createdAfter: "2026-01-01T00:00:00Z"
}
```

`issueFilter`:

- `all`
- `open-only`

`createdAfter` is optional ISO 8601. It applies to initial enumeration only.

### Discord source

```ts
bootstrap: {
	source: "discord",
	threadFilter: "all",
	createdAfter: "2026-01-01T00:00:00Z",
	stateOverrides: {
		"123456789012345678": {
			state: "closed",
			locked: false
		}
	}
}
```

`threadFilter`:

- `all`
- `active-only`

`stateOverrides` keys are Discord thread IDs. They resolve historical archived-state ambiguity and apply only during the approved bootstrap.

Changing bootstrap filters after bootstrap completion has no effect. Re-bootstrap requires explicit destructive cleanup and a new bootstrap.

## 8. Environment and secret loading

Forum Relay reads `config/.env` for local development. Production may provide real process environment variables.

For supported secrets, use exactly one of:

- `NAME=value`
- `NAME_FILE=/run/secrets/name`

Providing both is an error.

### Required

#### Discord

```dotenv
DISCORD_TOKEN=...
# or
DISCORD_TOKEN_FILE=/run/secrets/discord-token
```

#### Database

```dotenv
DB_FILE_NAME=file:.data/forum-relay.db
```

Remote libSQL URLs may include provider-specific authentication configuration when supported by the selected client configuration. Database URLs and credentials are treated as secrets in diagnostics.

#### GitHub App ID

```dotenv
GITHUB_APP_ID=123456
# or
GITHUB_APP_ID_FILE=/run/secrets/github-app-id
```

#### GitHub private key

Use exactly one:

```dotenv
GITHUB_PRIVATE_KEY_PATH=./config/github-app.pem
GITHUB_PRIVATE_KEY_BASE64=...
```

A private-key file should be mounted read-only.

#### GitHub webhook secret

```dotenv
GITHUB_WEBHOOK_SECRET=...
# or
GITHUB_WEBHOOK_SECRET_FILE=/run/secrets/github-webhook-secret
```

### Optional

#### `m.ticket.pm`

```dotenv
TICKETPM_TOKEN=...
# or
TICKETPM_TOKEN_FILE=/run/secrets/ticketpm-token
```

The token is optional. Without it, Forum Relay uses `m.ticket.pm`'s unauthenticated attachment endpoint. When configured,
the token is sent as bearer authentication. Configure at most one of the direct and `_FILE` forms.

### HTTP

```dotenv
HOST=0.0.0.0
PORT=3000
```

Defaults:

- `HOST=0.0.0.0`
- `PORT=3000`

The server speaks HTTP directly. An optional reverse proxy may add HTTPS without changing Forum Relay.

### Logging

```dotenv
LOG_LEVEL=info
```

Supported levels:

- `debug`
- `info`
- `warn`
- `error`

## 9. Validation

Global validation fails startup for:

- Missing/placeholder credentials.
- Unsupported config version.
- Duplicate mapping keys after normalization.
- Invalid public URL.
- Database/migration failure.
- Invalid global guild/client/owner IDs.

Mapping-local validation degrades only that mapping for:

- Missing/inaccessible repository.
- GitHub App installation absent.
- Discord forum missing or wrong channel type.
- Missing mapping permissions.
- Invalid role/log-channel references.
- Label/tag capacity failure.
- Repository read-only state.

`/relay doctor` reports actionable findings without revealing secrets.

## 10. GitHub App configuration

Repository permissions:

- Issues: read and write
- Contents: read
- Metadata: read

Subscribe to:

- Issues
- Issue comment
- Label
- Repository

Do not select **Installation target**. GitHub automatically sends the non-selectable `installation` and
`installation_repositories` lifecycle events to every GitHub App.

Webhook URL:

```text
{publicBaseUrl}/webhooks/github
```

The webhook secret must match `GITHUB_WEBHOOK_SECRET`.

The App may be installed on repositories not configured in Forum Relay. Their valid webhook events are acknowledged and ignored.

## 11. Discord application configuration

OAuth scopes:

- `bot`
- `applications.commands`

Bot permissions:

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

Privileged Gateway intent:

- Message Content

Non-privileged intents:

- Guilds
- Guild Messages

Commands are guild commands for the configured guild.

## 12. Sensitive local files

Never commit:

- `config/.env`
- `config/config.ts`
- GitHub private keys
- `.data/`
- Database backups

The database stores Discord webhook tokens in plaintext by explicit project policy. Protect database files, remote database credentials, and backups as secrets.

Diagnostic exports redact:

- Discord bot and webhook tokens
- GitHub App private key and installation tokens
- GitHub webhook secret
- `m.ticket.pm` token
- Authorization headers
- Signed media URLs
- Database credentials

## 13. Configuration changes after initialization

Allowed:

- Administrator/moderator role changes
- Log channel
- Presence
- Maintenance intervals/retention

Restricted:

- Mapping-key rename
- Forum replacement
- Repository immutable-ID replacement
- Bootstrap-source/filter changes after completion

Restricted changes require creating a new mapping or using the explicit cleanup/recovery CLI workflow.
