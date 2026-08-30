import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import type { NormalizedConfig } from "@/config/normalize.js";
import type { JsonObject } from "@/core/json.js";
import type { Logger } from "@/core/logger.js";
import type { JobRepository } from "@/db/job-repository.js";
import type { IssueThreadLink, RelayRepository } from "@/db/relay-repository.js";
import type { DiscordClient } from "@/discord/client.js";
import type { GitHubBootstrapIssue, GitHubClient } from "@/github/client.js";
import { RelayFailure } from "@/jobs/retry-policy.js";

export interface ReconciliationPreview {
	digest: string;
	mappingKey: string;
	missingDiscordThreads: number;
	missingGitHubIssues: number;
	unlinkedDiscordThreads: number;
	unlinkedGitHubIssues: number;
}

interface ReconciliationInventory {
	discordThreads: JsonObject[];
	githubIssues: GitHubBootstrapIssue[];
	links: IssueThreadLink[];
}

export class ReconciliationService {
	readonly #config: NormalizedConfig;
	readonly #database: Client;
	readonly #discord: DiscordClient;
	readonly #github: GitHubClient;
	readonly #jobs: JobRepository;
	readonly #logger: Logger;
	readonly #relay: RelayRepository;

	public constructor(options: {
		config: NormalizedConfig;
		database: Client;
		discord: DiscordClient;
		github: GitHubClient;
		jobs: JobRepository;
		logger: Logger;
		relay: RelayRepository;
	}) {
		this.#config = options.config;
		this.#database = options.database;
		this.#discord = options.discord;
		this.#github = options.github;
		this.#jobs = options.jobs;
		this.#logger = options.logger;
		this.#relay = options.relay;
	}

	public async preview(mappingKey: string): Promise<ReconciliationPreview> {
		this.#mapping(mappingKey);
		const inventory = await this.#inventory(mappingKey);
		const linkedGitHubIds = new Set(inventory.links.map((link) => link.githubIssueId));
		const linkedDiscordIds = new Set(inventory.links.flatMap((link) => (link.discordThreadId ? [link.discordThreadId] : [])));
		const remoteGitHubIds = new Set(inventory.githubIssues.map((issue) => issue.id));
		const remoteDiscordIds = new Set(inventory.discordThreads.map((thread) => String(thread.id)));
		const plan = {
			mappingKey,
			missingDiscordThreads: inventory.links.filter((link) => link.discordThreadId && !remoteDiscordIds.has(link.discordThreadId))
				.length,
			missingGitHubIssues: inventory.links.filter((link) => !remoteGitHubIds.has(link.githubIssueId)).length,
			unlinkedDiscordThreads: inventory.discordThreads.filter((thread) => !linkedDiscordIds.has(String(thread.id))).length,
			unlinkedGitHubIssues: inventory.githubIssues.filter((issue) => !linkedGitHubIds.has(issue.id)).length
		};
		return {
			...plan,
			digest: createHash("sha256").update(JSON.stringify(plan)).digest("hex")
		};
	}

	public async start(mappingKey: string, actorId?: string) {
		const preview = await this.preview(mappingKey);
		const inventory = await this.#inventory(mappingKey);
		const runId = crypto.randomUUID();
		const now = Date.now();
		await this.#database.execute({
			sql: `
				INSERT INTO reconciliation_runs (
					id, mapping_key, kind, state, plan_json, started_by_discord_user_id,
					started_at, created_at, updated_at
				) VALUES (?, ?, 'FULL', 'RUNNING', ?, ?, ?, ?, ?)
			`,
			args: [runId, mappingKey, JSON.stringify(preview), actorId ?? null, now, now, now]
		});

		const remoteGitHubIds = new Set(inventory.githubIssues.map((issue) => issue.id));
		const remoteDiscordIds = new Set(inventory.discordThreads.map((thread) => String(thread.id)));
		const linkedGitHubIds = new Set(inventory.links.map((link) => link.githubIssueId));
		const linkedDiscordIds = new Set(inventory.links.flatMap((link) => (link.discordThreadId ? [link.discordThreadId] : [])));
		const linksByGitHubId = new Map(inventory.links.map((link) => [link.githubIssueId, link]));
		const threadsById = new Map(inventory.discordThreads.map((thread) => [String(thread.id), thread]));

		for (const issue of inventory.githubIssues) {
			const linkedThreadId = linksByGitHubId.get(issue.id)?.discordThreadId;
			const linkedThread = linkedThreadId ? threadsById.get(linkedThreadId) : undefined;
			await this.#jobs.enqueueInbox({
				correlationId: runId,
				eventKind: "issues.edited",
				idempotencyKey: `reconcile:${runId}:issue:${issue.id}`,
				mappingKey,
				partitionKey: `reconcile:${mappingKey}:issue:${issue.id}`,
				payload: reconciliationPayload(issue.payload, linkedThread),
				platform: "github"
			});
			for (const comment of issue.comments) {
				const commentId =
					comment.comment && typeof comment.comment === "object" && !Array.isArray(comment.comment)
						? String(comment.comment.id)
						: crypto.randomUUID();
				await this.#jobs.enqueueInbox({
					correlationId: runId,
					eventKind: "issue_comment.created",
					idempotencyKey: `reconcile:${runId}:comment:${commentId}`,
					mappingKey,
					partitionKey: `reconcile:${mappingKey}:issue:${issue.id}`,
					payload: comment,
					platform: "github"
				});
			}
		}
		for (const thread of inventory.discordThreads) {
			const threadId = String(thread.id);
			if (!linkedDiscordIds.has(threadId)) {
				await this.#jobs.enqueueInbox({
					correlationId: runId,
					eventKind: "thread.create",
					idempotencyKey: `reconcile:${runId}:thread:${threadId}`,
					mappingKey,
					partitionKey: `discord:thread:${threadId}`,
					payload: thread,
					platform: "discord"
				});
			}
		}
		for (const link of inventory.links) {
			if (!remoteGitHubIds.has(link.githubIssueId)) {
				await this.#relay.markLinkStatus(link.id, "SOURCE_DELETED");
			} else if (link.discordThreadId && !remoteDiscordIds.has(link.discordThreadId)) {
				// Deleted human threads are not auto-recreated; that would resurrect intentionally removed content.
				await this.#relay.markLinkStatus(link.id, "MISSING");
			}
		}

		await this.#database.execute({
			sql: "UPDATE reconciliation_runs SET state = 'COMPLETED', completed_at = ?, updated_at = ? WHERE id = ?",
			args: [Date.now(), Date.now(), runId]
		});
		this.#logger.info("Reconciliation plan enqueued.", {
			mappingKey,
			runId,
			unlinkedGitHubIssues: inventory.githubIssues.filter((issue) => !linkedGitHubIds.has(issue.id)).length
		});
		return { preview, runId };
	}

	public async startAllActive() {
		const result = await this.#database.execute("SELECT key FROM mappings WHERE state = 'ACTIVE'");
		for (const row of result.rows) {
			if (typeof row.key !== "string") {
				continue;
			}
			try {
				await this.start(row.key);
			} catch (error) {
				this.#logger.warn("Scheduled reconciliation failed for a mapping.", {
					error: error instanceof Error ? error : String(error),
					mappingKey: row.key
				});
			}
		}
	}

	async #inventory(mappingKey: string): Promise<ReconciliationInventory> {
		const [discordThreads, githubIssues, links] = await Promise.all([
			this.#discord.bootstrapThreads(mappingKey, false),
			this.#github.bootstrapIssues(mappingKey),
			this.#relay.linksForMapping(mappingKey)
		]);
		return { discordThreads, githubIssues, links };
	}

	#mapping(mappingKey: string) {
		const mapping = this.#config.mappings[mappingKey];
		if (!mapping) {
			throw new RelayFailure(`Mapping "${mappingKey}" is not configured.`, "invalid", "MAPPING_NOT_FOUND");
		}
		return mapping;
	}
}

function reconciliationPayload(issue: JsonObject, thread: JsonObject | undefined): JsonObject {
	const metadata = thread?.thread_metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return issue;
	}
	return {
		...issue,
		forum_relay_reconciliation: {
			discord_archived: metadata.archived === true,
			discord_locked: metadata.locked === true
		}
	};
}
