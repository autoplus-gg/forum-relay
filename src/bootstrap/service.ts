import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import type { NormalizedConfig } from "@/config/normalize.js";
import type { JsonObject, JsonValue } from "@/core/json.js";
import { isJsonObject } from "@/core/json.js";
import type { Logger } from "@/core/logger.js";
import type { JobRepository } from "@/db/job-repository.js";
import type { DiscordClient } from "@/discord/client.js";
import type { GitHubClient } from "@/github/client.js";
import { RelayFailure } from "@/jobs/retry-policy.js";

export interface BootstrapPreview {
	blockers: string[];
	digest: string;
	mappingKey: string;
	sourceCount: number;
	sourcePlatform: "discord" | "github";
	targetCount: number;
	warnings: string[];
}

export class BootstrapService {
	readonly #config: NormalizedConfig;
	readonly #database: Client;
	readonly #discord: DiscordClient;
	readonly #github: GitHubClient;
	readonly #jobs: JobRepository;
	readonly #logger: Logger;
	readonly #monitors = new Map<string, ReturnType<typeof setInterval>>();

	public constructor(options: {
		config: NormalizedConfig;
		database: Client;
		discord: DiscordClient;
		github: GitHubClient;
		jobs: JobRepository;
		logger: Logger;
	}) {
		this.#config = options.config;
		this.#database = options.database;
		this.#discord = options.discord;
		this.#github = options.github;
		this.#jobs = options.jobs;
		this.#logger = options.logger;
	}

	public async preview(mappingKey: string): Promise<BootstrapPreview> {
		const mapping = this.#mapping(mappingKey);
		const githubIssues = await this.#filteredGitHubIssues(mappingKey);
		const discordThreads = await this.#filteredDiscordThreads(mappingKey);
		const sourcePlatform = mapping.bootstrap.source;
		const sourceCount = sourcePlatform === "github" ? githubIssues.length : discordThreads.length;
		const targetCount =
			sourcePlatform === "github"
				? (await this.#discord.bootstrapThreads(mappingKey, false)).length
				: (await this.#github.bootstrapIssues(mappingKey)).length;
		const blockers =
			targetCount === 0
				? []
				: [
						sourcePlatform === "github"
							? `The Discord forum contains ${targetCount} thread(s); bootstrap requires an empty target.`
							: `The GitHub repository contains ${targetCount} issue(s); bootstrap requires an empty target.`
					];
		const warnings =
			sourcePlatform === "discord"
				? [
						"Creating GitHub issues/comments may notify repository watchers; GitHub provides no notification-suppression option.",
						"GitHub creation timestamps cannot be backdated; original Discord timestamps remain in attribution."
					]
				: ["Private GitHub content copied to Discord becomes visible to every member who can read the forum."];
		const digest = createHash("sha256")
			.update(JSON.stringify({ mappingKey, sourceCount, sourcePlatform, targetCount, config: mapping.bootstrap }))
			.digest("hex");
		const preview = { blockers, digest, mappingKey, sourceCount, sourcePlatform, targetCount, warnings };
		const now = Date.now();
		await this.#database.execute({
			sql: `
				INSERT INTO bootstrap_jobs (
					id, mapping_key, state, source_platform, preview_digest, preview_json,
					created_at, updated_at
				) VALUES (?, ?, 'PREVIEW', ?, ?, ?, ?, ?)
			`,
			args: [crypto.randomUUID(), mappingKey, sourcePlatform, digest, JSON.stringify(preview), now, now]
		});
		return preview;
	}

	public async start(mappingKey: string, actorId: string) {
		const preview = await this.preview(mappingKey);
		if (preview.blockers.length > 0) {
			throw new RelayFailure(preview.blockers.join(" "), "invalid", "BOOTSTRAP_BLOCKED");
		}
		if (preview.sourcePlatform === "discord") {
			await this.#github.syncLabels(mappingKey, await this.#discord.forumTagNames(mappingKey));
			await this.#discord.syncForumTags(mappingKey);
		}

		const now = Date.now();
		const jobId = crypto.randomUUID();
		await this.#database.batch(
			[
				{
					sql: `
						INSERT INTO bootstrap_jobs (
							id, mapping_key, state, source_platform, preview_digest, preview_json,
							started_by_discord_user_id, started_at, created_at, updated_at
						) VALUES (?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?)
					`,
					args: [jobId, mappingKey, preview.sourcePlatform, preview.digest, JSON.stringify(preview), actorId, now, now, now]
				},
				{
					sql: "UPDATE mappings SET state = 'BOOTSTRAPPING', updated_at = ? WHERE key = ?",
					args: [now, mappingKey]
				}
			],
			"write"
		);
		await this.#enqueueSnapshot(mappingKey, jobId);
		this.#monitor(mappingKey, jobId);
		return { jobId, preview };
	}

	public async pause(mappingKey: string) {
		await this.#database.batch(
			[
				{
					sql: `
						UPDATE bootstrap_jobs SET state = 'PAUSED', updated_at = ?
						WHERE mapping_key = ? AND state = 'RUNNING'
					`,
					args: [Date.now(), mappingKey]
				},
				{
					sql: "UPDATE mappings SET state = 'PAUSED', updated_at = ? WHERE key = ? AND state = 'BOOTSTRAPPING'",
					args: [Date.now(), mappingKey]
				}
			],
			"write"
		);
		this.#stopMonitor(mappingKey);
	}

	public async resume(mappingKey: string) {
		const result = await this.#database.execute({
			sql: `
				SELECT id FROM bootstrap_jobs
				WHERE mapping_key = ? AND state IN ('PAUSED', 'FAILED')
				ORDER BY created_at DESC LIMIT 1
			`,
			args: [mappingKey]
		});
		const jobId = result.rows[0]?.id;
		if (typeof jobId !== "string") {
			throw new RelayFailure("No paused or failed bootstrap exists for this mapping.", "invalid", "BOOTSTRAP_NOT_RESUMABLE");
		}
		await this.#database.batch(
			[
				{
					sql: "UPDATE bootstrap_jobs SET state = 'RUNNING', updated_at = ? WHERE id = ?",
					args: [Date.now(), jobId]
				},
				{
					sql: "UPDATE mappings SET state = 'BOOTSTRAPPING', updated_at = ? WHERE key = ?",
					args: [Date.now(), mappingKey]
				}
			],
			"write"
		);
		await this.#jobs.resumeDeadThreadPendingLifecycles(mappingKey);
		await this.#enqueueSnapshot(mappingKey, jobId);
		this.#monitor(mappingKey, jobId);
		return { jobId };
	}

	public async resumeRunning() {
		const result = await this.#database.execute("SELECT id, mapping_key FROM bootstrap_jobs WHERE state = 'RUNNING'");
		for (const row of result.rows) {
			if (typeof row.id === "string" && typeof row.mapping_key === "string") {
				await this.#jobs.resumeDeadThreadPendingLifecycles(row.mapping_key);
				await this.#enqueueSnapshot(row.mapping_key, row.id);
				this.#monitor(row.mapping_key, row.id);
			}
		}
	}

	public stop() {
		for (const mappingKey of this.#monitors.keys()) {
			this.#stopMonitor(mappingKey);
		}
	}

	async #enqueueSnapshot(mappingKey: string, jobId: string) {
		const mapping = this.#mapping(mappingKey);
		let cursor = 0;
		if (mapping.bootstrap.source === "github") {
			const issues = await this.#filteredGitHubIssues(mappingKey);
			for (const issue of issues) {
				await this.#jobs.enqueueInbox({
					correlationId: jobId,
					eventKind: "issues.opened",
					idempotencyKey: `bootstrap:${jobId}:github:issue:${issue.id}`,
					mappingKey,
					partitionKey: `bootstrap:${mappingKey}:issue:${issue.id}`,
					payload: bootstrapPayload(issue.payload),
					platform: "github"
				});
				for (const comment of issue.comments) {
					const commentObject = requiredObject(comment, "bootstrap comment");
					const id = requiredObject(commentObject.comment, "bootstrap comment data").id;
					await this.#jobs.enqueueInbox({
						correlationId: jobId,
						eventKind: "issue_comment.created",
						idempotencyKey: `bootstrap:${jobId}:github:comment:${String(id)}`,
						mappingKey,
						partitionKey: `bootstrap:${mappingKey}:issue:${issue.id}`,
						payload: bootstrapPayload(comment),
						platform: "github"
					});
				}
				await this.#jobs.enqueueInbox({
					correlationId: jobId,
					eventKind: "bootstrap.github.state",
					idempotencyKey: `bootstrap:${jobId}:github:state:${issue.id}`,
					mappingKey,
					partitionKey: `bootstrap:${mappingKey}:issue:${issue.id}`,
					payload: bootstrapPayload(issue.payload),
					platform: "github"
				});
				cursor += 1;
				await this.#updateCursor(jobId, cursor);
			}
		} else {
			const threads = await this.#filteredDiscordThreads(mappingKey);
			for (const thread of threads) {
				const threadId = thread.id;
				await this.#jobs.enqueueInbox({
					correlationId: jobId,
					eventKind: "thread.create",
					idempotencyKey: `bootstrap:${jobId}:discord:thread:${String(threadId)}`,
					mappingKey,
					partitionKey: `discord:thread:${String(threadId)}`,
					payload: thread,
					platform: "discord"
				});
				for (const message of await this.#discord.bootstrapMessages(String(threadId))) {
					await this.#jobs.enqueueInbox({
						correlationId: jobId,
						eventKind: "message.create",
						idempotencyKey: `bootstrap:${jobId}:discord:message:${String(message.id)}`,
						mappingKey,
						partitionKey: `discord:thread:${String(threadId)}`,
						payload: message,
						platform: "discord"
					});
				}
				const metadata = thread.thread_metadata;
				const configuredOverride =
					mapping.bootstrap.source === "discord" ? mapping.bootstrap.stateOverrides?.[String(threadId)] : undefined;
				await this.#jobs.enqueueInbox({
					correlationId: jobId,
					eventKind: "bootstrap.discord.state",
					idempotencyKey: `bootstrap:${jobId}:discord:state:${String(threadId)}`,
					mappingKey,
					partitionKey: `discord:thread:${String(threadId)}`,
					payload: {
						locked: configuredOverride?.locked ?? Boolean(metadata && isJsonObject(metadata) && metadata.locked === true),
						state:
							configuredOverride?.state ?? (metadata && isJsonObject(metadata) && metadata.locked === true ? "closed" : "open"),
						threadId: String(threadId)
					},
					platform: "discord"
				});
				cursor += 1;
				await this.#updateCursor(jobId, cursor);
			}
		}
	}

	async #filteredGitHubIssues(mappingKey: string) {
		const bootstrap = this.#mapping(mappingKey).bootstrap;
		const issues = await this.#github.bootstrapIssues(mappingKey);
		return issues.filter((issue) => {
			if (bootstrap.createdAfter && Date.parse(issue.createdAt) < Date.parse(bootstrap.createdAfter)) {
				return false;
			}
			return bootstrap.source !== "github" || bootstrap.issueFilter !== "open-only" || issue.state === "open";
		});
	}

	async #filteredDiscordThreads(mappingKey: string) {
		const bootstrap = this.#mapping(mappingKey).bootstrap;
		const activeOnly = bootstrap.source === "discord" && bootstrap.threadFilter === "active-only";
		const threads = await this.#discord.bootstrapThreads(mappingKey, activeOnly);
		if (!bootstrap.createdAfter) {
			return threads;
		}
		const boundary = Date.parse(bootstrap.createdAfter);
		return threads.filter((thread) => snowflakeTimestamp(String(thread.id)) >= boundary);
	}

	async #updateCursor(jobId: string, position: number) {
		await this.#database.execute({
			sql: "UPDATE bootstrap_jobs SET cursor_json = ?, updated_at = ? WHERE id = ?",
			args: [JSON.stringify({ position }), Date.now(), jobId]
		});
	}

	#monitor(mappingKey: string, jobId: string) {
		this.#stopMonitor(mappingKey);
		const timer = setInterval(() => {
			void this.#finishIfDrained(mappingKey, jobId);
		}, 1_000);
		this.#monitors.set(mappingKey, timer);
	}

	async #finishIfDrained(mappingKey: string, jobId: string) {
		const result = await this.#database.execute({
			sql: `
				SELECT
					(SELECT COUNT(*) FROM inbox_events
						WHERE mapping_key = ? AND state IN ('pending', 'processing')) +
					(SELECT COUNT(*) FROM outbox_operations
						WHERE mapping_key = ? AND state IN ('pending', 'processing')) AS pending,
					(SELECT COUNT(*) FROM inbox_events
						WHERE mapping_key = ? AND correlation_id = ? AND state = 'dead') +
					(SELECT COUNT(*) FROM outbox_operations
						WHERE mapping_key = ? AND state = 'dead') AS dead
			`,
			args: [mappingKey, mappingKey, mappingKey, jobId, mappingKey]
		});
		if (Number(result.rows[0]?.pending ?? 1) !== 0) {
			return;
		}
		const now = Date.now();
		if (Number(result.rows[0]?.dead ?? 0) > 0) {
			await this.#database.batch(
				[
					{
						sql: "UPDATE bootstrap_jobs SET state = 'FAILED', completed_at = ?, updated_at = ? WHERE id = ?",
						args: [now, now, jobId]
					},
					{
						sql: `
							UPDATE mappings SET state = 'DEGRADED', last_error_code = 'BOOTSTRAP_DEAD_LETTER',
								last_error_message = 'Bootstrap contains dead-letter work.', updated_at = ? WHERE key = ?
						`,
						args: [now, mappingKey]
					}
				],
				"write"
			);
			this.#stopMonitor(mappingKey);
			return;
		}
		await this.#database.batch(
			[
				{
					sql: "UPDATE bootstrap_jobs SET state = 'COMPLETED', completed_at = ?, updated_at = ? WHERE id = ?",
					args: [now, now, jobId]
				},
				{
					sql: `
						UPDATE mappings SET state = 'ACTIVE', bootstrap_completed_at = ?,
							last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE key = ?
					`,
					args: [now, now, mappingKey]
				}
			],
			"write"
		);
		this.#stopMonitor(mappingKey);
		this.#logger.info("Bootstrap completed.", { jobId, mappingKey });
	}

	#stopMonitor(mappingKey: string) {
		const timer = this.#monitors.get(mappingKey);
		if (timer) {
			clearInterval(timer);
			this.#monitors.delete(mappingKey);
		}
	}

	#mapping(mappingKey: string) {
		const mapping = this.#config.mappings[mappingKey];
		if (!mapping) {
			throw new RelayFailure(`Mapping "${mappingKey}" is not configured.`, "invalid", "MAPPING_NOT_FOUND");
		}
		return mapping;
	}
}

function snowflakeTimestamp(id: string) {
	return Number((BigInt(id) >> 22n) + 1_420_070_400_000n);
}

function bootstrapPayload(payload: JsonObject): JsonObject {
	return { ...payload, forum_relay_bootstrap: true };
}

function requiredObject(value: JsonValue | undefined, label: string): JsonObject {
	if (!value || !isJsonObject(value)) {
		throw new RelayFailure(`Expected ${label} to be an object.`, "invalid", "BOOTSTRAP_PAYLOAD");
	}
	return value;
}
