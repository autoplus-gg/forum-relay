# Security Policy

## Reporting

Do not open a public issue for a vulnerability, leaked token, private webhook payload, Discord message, GitHub issue body,
or database.

Use GitHub's private vulnerability reporting for `autoplus-gg/forum-relay`. Include the affected version or commit,
impact, reproduction steps, and a sanitized proof of concept. Remove real bot tokens, App keys, webhook
secrets/signatures, webhook tokens, signed URLs, user content, and private repository data.

If private vulnerability reporting is temporarily unavailable, do not publish the report; contact AutoPlus.gg privately
through the organization profile instead.

## Supported versions

Security fixes target the latest published release and the current `main` branch. Releases older than the latest published
version are not supported unless a security advisory says otherwise.

## Operator responsibilities

- Keep the Discord bot and GitHub App private.
- Use least-privilege Discord and GitHub permissions.
- Prefer HTTPS whenever webhook traffic crosses an untrusted network. Plain HTTP is supported, but webhook signatures do
  not encrypt payloads in transit.
- Protect `config/.env`, the GitHub private key, database, and backups.
- Rotate credentials after suspected exposure.
- Keep Bun and dependencies updated.
- Understand that `m.ticket.pm` attachment bytes are immutable and non-deletable.

Forum Relay does not provide a public hosted service and does not collect telemetry.
