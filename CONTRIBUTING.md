# Contributing

Forum Relay targets Bun and TypeScript. Node.js runtime compatibility is not a goal.

## Development

```sh
bun install
bun run prepare:config
bun run check
bun run test:coverage
bun run build
```

Vitest must run through Bun (`bun --bun vitest`). Whole-core coverage may not fall below the configured baseline. The
domain, webhook, label, and rendering thresholds in `vitest.config.ts` protect the most deterministic synchronization
logic more strictly; new behavior should increase those baselines instead of weakening them.

## Code style

- Do not use `any` or `unknown`.
- Model uncertain input explicitly and validate it at platform/database boundaries.
- Keep external adapters thin and put synchronization decisions in tested domain modules.
- Add comments for non-obvious invariants, tradeoffs, and edge cases—not narration.
- Preserve durable idempotency and per-item ordering for every new mutation.
- Disable cross-platform mention notifications on every send and edit.
- Never fetch an untrusted remote URL without the media safety boundary.

Use Conventional Commits when commits are created.

## Fixtures

Only contribute sanitized fixtures. Replace repository/guild/channel/thread/message/user IDs, usernames, avatars, issue bodies, attachment URLs, delivery IDs, signatures, installation IDs, and tokens. Do not submit private Discord or GitHub content even when it appears harmless.

## Pull requests

Explain the behavior and compatibility impact. Include tests for event replay, retries, limits, and conflicting edits where applicable.
