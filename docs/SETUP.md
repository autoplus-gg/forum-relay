# Setup and Deployment

Forum Relay is self-hosted. AutoPlus.gg does not provide a shared public bot or GitHub App.

## 1. Requirements

- Bun 1.x
- A Discord server with a Forum channel
- A GitHub repository with Issues enabled
- A public HTTP or HTTPS address for GitHub webhooks
- SQLite storage on a persistent volume, or a remote libSQL database

The Discord bot, GitHub App, database, backups, private key, and webhook secret belong to the operator.

## 2. Discord application

Create an application in the Discord Developer Portal, add a bot, and keep it private.

Enable the privileged **Message Content Intent**. Forum Relay also uses the Guilds and Guild Messages intents.

Install the application in one server with the `bot` and `applications.commands` scopes. Grant only the permissions needed in the mapped forum and optional log channel:

- View Channel
- Send Messages
- Send Messages in Threads
- Read Message History
- Manage Threads
- Manage Channels
- Manage Webhooks
- View Audit Log

`Manage Webhooks` is needed because each mapping owns one dedicated application webhook. GitHub-authored messages use that webhook so their visible username and avatar match the GitHub author. The bot itself handles Gateway events, commands, permissions, thread state, and audit-log classification.

Copy the application ID to `clientId` in `config/config.ts`, the server ID to `guildId`, and the bot token to `DISCORD_TOKEN` or `DISCORD_TOKEN_FILE`.

## 3. GitHub App

Create a private GitHub App owned by the personal account or organization that owns the repositories being synchronized.
Forum Relay does not use a personal access token, GitHub OAuth, or a shared public App.

### 3.1 Open the registration form

Use the appropriate direct link while signed in to GitHub:

- [Create an App owned by your personal account](https://github.com/settings/apps/new)
- Create an organization-owned App at
  `https://github.com/organizations/ORGANIZATION/settings/apps/new`, replacing `ORGANIZATION` with its GitHub login.

You must be an organization owner or GitHub App manager to register an organization-owned App. Registering it under the
same account that owns the repositories allows the App to remain private.

### 3.2 Basic information

Fill in the registration form as follows:

| GitHub field | Value |
| --- | --- |
| GitHub App name | Any globally unique name, such as `My Community Forum Relay` |
| Description | Optional |
| Homepage URL | `https://github.com/autoplus-gg/forum-relay` or your deployment/project page |
| Callback URL | None; click **Delete** if GitHub displays an empty callback row |
| Expire user authorization tokens | Leave enabled |
| Request user authorization (OAuth) during installation | Disabled |
| Enable Device Flow | Disabled |
| Setup URL | Leave empty |
| Redirect on update | Disabled |

Forum Relay authenticates only as the App installation, so it does not need to identify or authorize individual GitHub
users. Consequently, the user-token expiration setting has no runtime effect; leaving GitHub's safer default enabled also
avoids weakening the App if user authorization is ever added in a future config version.

### 3.3 Webhook

Enable **Active** under the Webhook section.

Set its webhook URL to:

```text
http://relay.example.com:3000/webhooks/github
```

Replace the origin with the exact `publicBaseUrl` from `config/config.ts`. The `/webhooks/github` path is fixed. The
address must be publicly reachable by GitHub before deliveries can succeed.

Generate a random webhook secret of at least 32 bytes with a password manager or cryptographically secure random
generator. Enter the same value in:

- The GitHub registration form's **Webhook secret** field.
- `GITHUB_WEBHOOK_SECRET` or `GITHUB_WEBHOOK_SECRET_FILE` in Forum Relay.

Do not reuse the Discord token, private key, or another account password as this secret.

### 3.4 Permissions and events

Set only these **Repository permissions**:

| Permission | Access |
| --- | --- |
| Issues | Read and write |
| Contents | Read-only |
| Metadata | Read-only |

If the App was already installed before you enabled **Contents: Read-only**, approve the pending permission update in
the App installation settings. Saving the App registration alone does not update an existing installation.

To mirror organization Project activity into Discord, also set this **Organization permission**:

| Permission | Access |
| --- | --- |
| Projects | Read-only |

The Projects permission is optional when you do not use organization Projects. Leave every other repository,
organization, and account permission set to **No access**.

Under **Subscribe to events**, select:

- Issues
- Issue comment
- Issue dependencies
- Label
- Repository
- Sub issues

When the App has the optional organization Projects permission, also select:

- Projects v2 item

`Projects v2 item` is an organization-only public-preview webhook. It lets Forum Relay immediately log adding or
removing an issue from a Project, Project field changes such as Status moves, archiving, restoring, and reordering. The
permission is read-only: Forum Relay observes Project activity but does not modify Projects.

When adding the Projects permission to an App that is already installed, approve the new permission request from the
App installation settings for the organization. Until an organization owner approves it, GitHub will not grant the
installation token Project access or deliver `Projects v2 item` events.

The list of available events changes when permissions change. Configure the permissions first if an event is not shown.
Leave **Installation target** unchecked; it only reports that the owning user or organization was renamed. GitHub sends
the separate `installation` and `installation_repositories` lifecycle events to every GitHub App automatically, so they
do not appear as selectable checkboxes.

Under **Where can this GitHub App be installed?**, choose **Only on this account**. This keeps the App private to its
owner. Then click **Create GitHub App**.

### 3.5 App ID and private key

After creation:

1. Copy the numeric **App ID** from the App's settings page into `GITHUB_APP_ID`.
2. Scroll to **Private keys** and click **Generate a private key**.
3. GitHub downloads a `.pem` file once. Move it to `config/github-app.pem`.
4. Set `GITHUB_PRIVATE_KEY_PATH=./config/github-app.pem`.

Alternatively, base64-encode the complete PEM and set `GITHUB_PRIVATE_KEY_BASE64`. Configure only one of the path and
base64 options. The PEM is ignored by Git, but it must still be treated as a secret and backed up securely.

### 3.6 Install the App

From the App's settings page:

1. Select **Install App** in the sidebar.
2. Select **Install** beside the owning personal account or organization.
3. Choose **Only select repositories**.
4. Select every repository referenced by a Forum Relay mapping.
5. Complete the installation.

If a repository is added to `config.ts` later, update the existing installation and grant it access to that repository.
Do not create another App installation for each mapping.

### 3.7 Configure and verify

The resulting environment configuration should contain:

```dotenv
GITHUB_APP_ID=123456
GITHUB_WEBHOOK_SECRET=your-random-webhook-secret
GITHUB_PRIVATE_KEY_PATH=./config/github-app.pem
```

Start Forum Relay, then verify:

1. Open `{publicBaseUrl}/health/live` and confirm it returns HTTP `200`.
2. In the GitHub App settings, open **Advanced** and inspect **Recent deliveries**.
3. Redeliver GitHub's `ping` delivery, or create a temporary issue in an installed repository.
4. Confirm the delivery receives HTTP `202` from `/webhooks/github`.
5. Run `/relay doctor` in Discord and confirm that the mapping has no GitHub installation or webhook errors.

At startup, Forum Relay logs the complete `githubWebhookUrl` it expects. Every authenticated delivery then logs either
`Accepted GitHub webhook.` or `Ignored GitHub webhook.` with its event kind and delivery ID. If GitHub reports a
delivery but neither message appears, compare GitHub's delivery URL with the startup value exactly. Startup also inspects
the GitHub App and warns when the configured URL, JSON content type, or required event subscriptions do not match.

An HTTP `401` delivery means the webhook secrets do not match. `404` usually means the `/webhooks/github` path is
missing from the configured URL. Connection failures mean the host, port forwarding, firewall, or process is not publicly
reachable.

Forum Relay authenticates as the App and its installation. It never requires a GitHub user account or personal access token.

## 4. Configuration

Copy the examples:

```sh
cp config/example.env config/.env
cp config/config.example.ts config/config.ts
```

Edit both files using the [configuration reference](CONFIGURATION.md). A mapping key permanently identifies one Forum↔repository relationship. Changing its forum or repository in place is refused; use the offline cleanup/migration workflow instead.

Repository labels are synchronized automatically; no label mapping belongs in configuration. A forum supports at most 20 available tags and Discord applies at most five to a thread. Existing case-insensitive tags are reused, long GitHub names are shortened deterministically, and definitions beyond the forum's remaining capacity stay GitHub-only with a warning.

Secrets can be supplied directly or through their corresponding `_FILE` variable. Setting both forms is rejected. The database intentionally stores dedicated Discord webhook tokens in plaintext, so treat the database and backups as secrets.

## 5. Native Bun deployment

```sh
bun install --frozen-lockfile
bun run check
bun run test:coverage
bun run start
```

Use a process supervisor that sends `SIGTERM`, preserves `.data`, and restarts after failure. Only one process may own a database; a renewable database lease makes additional processes inactive.

## 6. Docker Compose

```sh
docker compose up --build -d
```

The included Compose file mounts `./config` read-only and persists `./.data`. Back up both the configuration/secrets and the database volume separately.

### Pterodactyl or Pelican

The generic Bun egg works with the Bun Latest and Bun Canary yolks. Set **Main File** to `src/index.ts` so the egg starts
Forum Relay directly with `bun run src/index.ts` instead of nesting it through the package `start` script.

Set the server allocation port and `PORT` to the same value, preserve `config/` and `.data/`, and provide secrets through
`config/.env` or panel environment variables. The egg's `^^C` stop action is supported explicitly: Forum Relay recognizes
both an OS `SIGINT` and a Ctrl+C/ETX byte received through stdin.

## 7. Public webhook endpoint

`Bun.serve` listens directly on `HOST`/`PORT`. The default Docker Compose configuration publishes port `3000`, so the
simplest deployment only needs TCP port `3000` forwarded through the firewall/router and this GitHub App webhook URL:

```text
http://YOUR_PUBLIC_HOST_OR_IP:3000/webhooks/github
```

The webhook secret is always required and Forum Relay rejects payloads whose HMAC signature is invalid. HTTP does not
encrypt payloads in transit, so HTTPS may still be added later with a reverse proxy if wanted. Example nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    client_max_body_size 2m;
}
```

Expose only:

- `POST /webhooks/github`
- `GET /health/live`
- `GET /health/ready`

Health responses contain no credentials or mapping details. `/health/ready` returns 503 until the worker lease and at least one Discord/GitHub mapping initialize.

## 8. First bootstrap

Historical import never starts automatically.

1. Start Forum Relay so live webhooks and Gateway events enter the durable inbox.
2. Run `/relay bootstrap preview mapping:<key>`.
3. Read the empty-target blocker and notification/privacy warnings.
4. Run `/relay bootstrap start mapping:<key>`.
5. Use `/relay bootstrap pause` or `/relay bootstrap resume` when needed.
6. Watch `/relay status`, `/relay doctor`, and structured stdout logs.

GitHub-source bootstrap supports `all`, `open-only`, and `createdAfter`. Discord-source bootstrap supports `all`, `active-only`, `createdAfter`, and configured state overrides. Imports are oldest-first and idempotent.

GitHub cannot suppress notifications or backdate issue/comment creation. Discord-to-GitHub previews explicitly warn about this.

## 9. Attachment privacy

Discord attachments are submitted to the `m.ticket.pm` v2 media proxy. Anonymous uploads are supported by default; an
optional `TICKETPM_TOKEN` is sent as bearer authentication when configured. Returned bytes are immutable and the service
has no deletion endpoint. Editing or deleting a message removes links but cannot remove already proxied bytes.

GitHub images are parsed from Markdown and sanitized HTML `<img>` nodes. Server-side downloads are restricted to recognized GitHub hosts with DNS, redirect, size, timeout, and MIME checks. Arbitrary external images are never fetched by Forum Relay.
