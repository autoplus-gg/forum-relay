import type { Client, Row } from "@libsql/client";
import type { JsonObject, JsonValue } from "@/core/json.js";
import { isJsonObject, parseJson } from "@/core/json.js";
import type { Logger } from "@/core/logger.js";
import type { JobRepository } from "@/db/job-repository.js";
import type { RelayRepository } from "@/db/relay-repository.js";
import type { DiscordClient } from "@/discord/client.js";
import { classifyThreadTransition, type ThreadState } from "@/domain/state-transitions.js";

interface AuditJob {
	attemptCount: number;
	id: string;
	mappingKey: string;
	observed: JsonObject;
	observedAt: number;
	threadId: string;
}

export class AuditClassifier {
	readonly #applicationId: string;
	readonly #database: Client;
	readonly #discord: DiscordClient;
	readonly #jobs: JobRepository;
	readonly #logger: Logger;
	readonly #relay: RelayRepository;
	#active = false;
	#timer?: ReturnType<typeof setTimeout>;

	public constructor(options: {
		applicationId: string;
		database: Client;
		discord: DiscordClient;
		jobs: JobRepository;
		logger: Logger;
		relay: RelayRepository;
	}) {
		this.#applicationId = options.applicationId;
		this.#database = options.database;
		this.#discord = options.discord;
		this.#jobs = options.jobs;
		this.#logger = options.logger;
		this.#relay = options.relay;
	}

	public start() {
		if (this.#active) {
			return;
		}
		this.#active = true;
		this.#schedule(0);
	}

	public stop() {
		this.#active = false;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	async #tick() {
		const job = await this.#claim();
		if (!job) {
			this.#schedule(1_000);
			return;
		}
		try {
			await this.#classify(job);
		} catch (error) {
			this.#logger.warn("Discord audit classification failed.", {
				error: error instanceof Error ? error : String(error),
				threadId: job.threadId
			});
			await this.#retry(job, "AUDIT_QUERY_FAILED");
		}
		this.#schedule(0);
	}

	async #claim() {
		const now = Date.now();
		const result = await this.#database.execute({
			sql: `
				UPDATE audit_classification_jobs
				SET state = 'PROCESSING', attempt_count = attempt_count + 1, updated_at = ?
				WHERE id = (
					SELECT id FROM audit_classification_jobs
					WHERE state = 'PENDING' AND next_attempt_at <= ?
					ORDER BY observed_at LIMIT 1
				)
				RETURNING *
			`,
			args: [now, now]
		});
		return result.rows[0] ? toAuditJob(result.rows[0]) : undefined;
	}

	async #classify(job: AuditJob) {
		const link = await this.#relay.findLinkByDiscord(job.mappingKey, job.threadId);
		if (!link) {
			await this.#complete(job, "UNLINKED");
			return;
		}
		const metadata = job.observed.thread_metadata;
		if (!metadata || !isJsonObject(metadata)) {
			await this.#complete(job, "NO_THREAD_METADATA");
			return;
		}
		const archived = metadata.archived === true;
		const locked = metadata.locked === true;
		const audit = await this.#discord.recentThreadAuditLog();
		const evidence = findEvidence(audit, job.threadId, job.observedAt);

		if (!evidence && job.attemptCount < 3) {
			await this.#retry(job, "AUDIT_EVIDENCE_PENDING");
			return;
		}
		const observedName = typeof job.observed.name === "string" ? job.observed.name : undefined;
		const appliedTags = jsonArray(job.observed.applied_tags).filter((value): value is string => typeof value === "string");
		const previous: ThreadState = {
			appliedTags: undefined,
			archived: link.state === "closed",
			locked: link.locked,
			name: link.fullTitle
		};
		const observed: ThreadState = {
			appliedTags: Array.isArray(job.observed.applied_tags) ? appliedTags : undefined,
			archived,
			locked,
			name: observedName ?? link.fullTitle
		};
		const transition = classifyThreadTransition(
			previous,
			observed,
			!evidence ? "none" : evidence.actorId === this.#applicationId ? "self" : "human-audit"
		);
		if (
			transition.kind === "none" ||
			transition.kind === "self" ||
			transition.kind === "ambiguous" ||
			transition.kind === "inactivity-archive"
		) {
			await this.#complete(job, transition.kind.toLocaleUpperCase("en-US").replaceAll("-", "_"));
			return;
		}
		if (!evidence) {
			await this.#complete(job, "AMBIGUOUS");
			return;
		}
		const action = transition.kind;
		const operationId = await this.#jobs.enqueueOutbox({
			correlationId: crypto.randomUUID(),
			idempotencyKey: `github:lifecycle:audit:${job.id}:${action}`,
			mappingKey: job.mappingKey,
			operationKind: "github.issue.lifecycle",
			partitionKey: `link:${link.id}`,
			payload: {
				action,
				actor: {
					displayName: evidence.actorName,
					id: evidence.actorId,
					username: evidence.actorName
				},
				labels: transition.kind === "labels" ? await this.#relay.githubLabelsForTags(job.mappingKey, transition.tagIds) : [],
				linkId: link.id,
				reason: "completed",
				title: transition.kind === "rename" ? transition.title : observed.name
			},
			platform: "github"
		});
		await this.#complete(job, operationId ? `MANUAL_${action.toLocaleUpperCase("en-US")}` : "DUPLICATE_OPERATION");
	}

	async #retry(job: AuditJob, code: string) {
		if (job.attemptCount >= 5) {
			await this.#complete(job, "AMBIGUOUS");
			return;
		}
		await this.#database.execute({
			sql: `
				UPDATE audit_classification_jobs SET state = 'PENDING', classification = ?,
					next_attempt_at = ?, updated_at = ? WHERE id = ?
			`,
			args: [code, Date.now() + 2_000, Date.now(), job.id]
		});
	}

	async #complete(job: AuditJob, classification: string) {
		await this.#database.execute({
			sql: `
				UPDATE audit_classification_jobs SET state = 'COMPLETED', classification = ?,
					updated_at = ? WHERE id = ?
			`,
			args: [classification, Date.now(), job.id]
		});
	}

	#schedule(delayMs: number) {
		if (!this.#active) {
			return;
		}
		this.#timer = setTimeout(() => void this.#tick(), delayMs);
	}
}

function findEvidence(audit: JsonObject, threadId: string, observedAt: number) {
	for (const entryValue of jsonArray(audit.audit_log_entries)) {
		if (!isJsonObject(entryValue) || String(entryValue.target_id) !== threadId) {
			continue;
		}
		const id = entryValue.id;
		const actorId = entryValue.user_id;
		if (typeof id !== "string" || typeof actorId !== "string") {
			continue;
		}
		const timestamp = snowflakeTimestamp(id);
		if (Math.abs(timestamp - observedAt) > 30_000) {
			continue;
		}
		const user = jsonArray(audit.users).find((candidate) => isJsonObject(candidate) && candidate.id === actorId);
		const actorName = user && isJsonObject(user) && typeof user.username === "string" ? user.username : `user-${actorId}`;
		return { actorId, actorName };
	}
	return undefined;
}

function toAuditJob(row: Row): AuditJob {
	const observed = parseJson(String(row.observed_state_json));
	if (!isJsonObject(observed)) {
		throw new Error("Audit observed state must be an object.");
	}
	return {
		attemptCount: Number(row.attempt_count),
		id: String(row.id),
		mappingKey: String(row.mapping_key),
		observed,
		observedAt: Number(row.observed_at),
		threadId: String(row.thread_id)
	};
}

function jsonArray(value: JsonValue | undefined) {
	return Array.isArray(value) ? value : [];
}

function snowflakeTimestamp(id: string) {
	return Number((BigInt(id) >> 22n) + 1_420_070_400_000n);
}
