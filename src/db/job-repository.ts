import type { Client, InValue, Row } from "@libsql/client";
import type { JsonValue } from "@/core/json.js";
import { parseJson } from "@/core/json.js";
import type { RelayFailure, RetryDecision } from "@/jobs/retry-policy.js";

export type JobPlatform = "discord" | "github" | "media" | "system";
export type JobState = "completed" | "dead" | "pending" | "processing";

export interface EnqueueInbox {
	correlationId?: string;
	eventKind: string;
	idempotencyKey: string;
	mappingKey?: string;
	partitionKey?: string;
	payload: JsonValue;
	platform: JobPlatform;
}

export interface EnqueueOutbox {
	correlationId: string;
	dependsOn?: readonly string[];
	expectedSourceRevision?: string;
	idempotencyKey: string;
	mappingKey: string;
	operationKind: string;
	partitionKey: string;
	payload: JsonValue;
	platform: Exclude<JobPlatform, "system">;
	relayItemId?: string;
}

export interface ClaimedJob {
	attemptCount: number;
	correlationId: string;
	eventKind: string;
	id: string;
	mappingKey?: string;
	partitionKey?: string;
	payload: JsonValue;
	platform: JobPlatform;
}

export interface ClaimedOperation {
	attemptCount: number;
	correlationId: string;
	expectedSourceRevision?: string;
	id: string;
	mappingKey: string;
	operationKind: string;
	partitionKey: string;
	payload: JsonValue;
	platform: Exclude<JobPlatform, "system">;
	relayItemId?: string;
}

export class JobRepository {
	public constructor(private readonly client: Client) {}

	public async enqueueInbox(event: EnqueueInbox) {
		const now = Date.now();
		const result = await this.client.execute({
			sql: `
				INSERT OR IGNORE INTO inbox_events (
					id, idempotency_key, platform, event_kind, mapping_key, partition_key,
					payload_json, state, attempt_count, next_attempt_at, correlation_id,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
			`,
			args: [
				crypto.randomUUID(),
				event.idempotencyKey,
				event.platform,
				event.eventKind,
				event.mappingKey ?? null,
				event.partitionKey ?? null,
				JSON.stringify(event.payload),
				now,
				event.correlationId ?? crypto.randomUUID(),
				now,
				now
			]
		});
		return result.rowsAffected === 1;
	}

	public async claimInbox(owner: string, claimDurationMs: number, now = Date.now()) {
		const result = await this.client.execute({
			sql: `
				UPDATE inbox_events
				SET state = 'processing', claim_owner = ?, claim_expires_at = ?,
					attempt_count = attempt_count + 1, updated_at = ?
				WHERE id = (
					SELECT candidate.id
					FROM inbox_events candidate
					WHERE (
						(candidate.state = 'pending' AND candidate.next_attempt_at <= ?)
						OR (candidate.state = 'processing' AND candidate.claim_expires_at <= ?)
					)
					AND (
						candidate.mapping_key IS NULL OR EXISTS (
							SELECT 1 FROM mappings mapping
							WHERE mapping.key = candidate.mapping_key
								AND mapping.state IN ('ACTIVE', 'BOOTSTRAPPING')
						)
					)
					AND NOT EXISTS (
						SELECT 1 FROM inbox_events earlier
						WHERE candidate.partition_key IS NOT NULL
							AND earlier.partition_key = candidate.partition_key
							-- Millisecond timestamps can collide during bootstrap; rowid
							-- preserves the actual insertion order within the partition.
							AND earlier.rowid < candidate.rowid
							AND earlier.state IN ('pending', 'processing')
					)
					ORDER BY candidate.rowid
					LIMIT 1
				)
				RETURNING *
			`,
			args: [owner, now + claimDurationMs, now, now, now]
		});
		return result.rows[0] ? toClaimedJob(result.rows[0]) : undefined;
	}

	public async completeInbox(id: string, owner: string, now = Date.now()) {
		return this.finishClaim("inbox_events", id, owner, "completed", now);
	}

	public async failInbox(id: string, owner: string, failure: RelayFailure, decision: RetryDecision, now = Date.now()) {
		return this.failClaim("inbox_events", id, owner, failure, decision, now);
	}

	public async enqueueOutbox(operation: EnqueueOutbox) {
		const now = Date.now();
		const transaction = await this.client.transaction("write");

		try {
			const id = crypto.randomUUID();
			const result = await transaction.execute({
				sql: `
					INSERT OR IGNORE INTO outbox_operations (
						id, idempotency_key, platform, operation_kind, mapping_key, partition_key,
						relay_item_id, expected_source_revision, payload_json, state, attempt_count,
						next_attempt_at, correlation_id, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
				`,
				args: [
					id,
					operation.idempotencyKey,
					operation.platform,
					operation.operationKind,
					operation.mappingKey,
					operation.partitionKey,
					operation.relayItemId ?? null,
					operation.expectedSourceRevision ?? null,
					JSON.stringify(operation.payload),
					now,
					operation.correlationId,
					now,
					now
				]
			});

			if (result.rowsAffected === 1) {
				for (const dependency of operation.dependsOn ?? []) {
					await transaction.execute({
						sql: "INSERT INTO operation_dependencies (operation_id, depends_on_operation_id) VALUES (?, ?)",
						args: [id, dependency]
					});
				}
			}

			await transaction.commit();
			return result.rowsAffected === 1 ? id : undefined;
		} catch (error) {
			await transaction.rollback();
			throw error;
		}
	}

	public async claimOutbox(owner: string, claimDurationMs: number, now = Date.now()) {
		const result = await this.client.execute({
			sql: `
				UPDATE outbox_operations
				SET state = 'processing', claim_owner = ?, claim_expires_at = ?,
					attempt_count = attempt_count + 1, updated_at = ?
				WHERE id = (
					SELECT candidate.id
					FROM outbox_operations candidate
					WHERE (
						(candidate.state = 'pending' AND candidate.next_attempt_at <= ?)
						OR (candidate.state = 'processing' AND candidate.claim_expires_at <= ?)
					)
					AND EXISTS (
						SELECT 1 FROM mappings mapping
						WHERE mapping.key = candidate.mapping_key
							AND mapping.state IN ('ACTIVE', 'BOOTSTRAPPING')
					)
					AND NOT EXISTS (
						SELECT 1
						FROM operation_dependencies dependency
						JOIN outbox_operations prerequisite ON prerequisite.id = dependency.depends_on_operation_id
						WHERE dependency.operation_id = candidate.id AND prerequisite.state != 'completed'
					)
					AND NOT EXISTS (
						SELECT 1 FROM outbox_operations earlier
						WHERE earlier.partition_key = candidate.partition_key
							AND earlier.rowid < candidate.rowid
							AND earlier.state IN ('pending', 'processing')
							-- Repair a pre-existing bootstrap inversion: a lifecycle
							-- retry waiting for a thread must not block its creator.
							AND NOT (
								candidate.operation_kind = 'discord.item.sync'
								AND earlier.operation_kind = 'discord.issue.lifecycle'
								AND EXISTS (
									SELECT 1 FROM outbox_operations thread_waiter
									WHERE thread_waiter.partition_key = candidate.partition_key
										AND thread_waiter.rowid < candidate.rowid
										AND thread_waiter.operation_kind = 'discord.issue.lifecycle'
										AND thread_waiter.last_error_code = 'THREAD_PENDING'
								)
							)
					)
					ORDER BY candidate.rowid
					LIMIT 1
				)
				RETURNING *
			`,
			args: [owner, now + claimDurationMs, now, now, now]
		});
		return result.rows[0] ? toClaimedOperation(result.rows[0]) : undefined;
	}

	public async completeOutbox(id: string, owner: string, result: JsonValue, now = Date.now()) {
		const completion = await this.client.execute({
			sql: `
				UPDATE outbox_operations
				SET state = 'completed', result_json = ?, completed_at = ?, claim_owner = NULL,
					claim_expires_at = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = ?
				WHERE id = ? AND state = 'processing' AND claim_owner = ?
			`,
			args: [JSON.stringify(result), now, now, id, owner]
		});
		return completion.rowsAffected === 1;
	}

	public async failOutbox(id: string, owner: string, failure: RelayFailure, decision: RetryDecision, now = Date.now()) {
		return this.failClaim("outbox_operations", id, owner, failure, decision, now);
	}

	public async resumeThreadPendingLifecycles(partitionKey: string, now = Date.now()) {
		const result = await this.client.execute({
			sql: `
				UPDATE outbox_operations
				SET state = 'pending', attempt_count = 0, next_attempt_at = ?,
					claim_owner = NULL, claim_expires_at = NULL,
					last_error_code = NULL, last_error_message = NULL, updated_at = ?
				WHERE partition_key = ?
					AND operation_kind = 'discord.issue.lifecycle'
					AND state IN ('dead', 'pending')
					AND last_error_code = 'THREAD_PENDING'
			`,
			args: [now, now, partitionKey]
		});
		return result.rowsAffected;
	}

	public async resumeDeadThreadPendingLifecycles(mappingKey: string, now = Date.now()) {
		const result = await this.client.execute({
			sql: `
				UPDATE outbox_operations
				SET state = 'pending', attempt_count = 0, next_attempt_at = ?,
					claim_owner = NULL, claim_expires_at = NULL,
					last_error_code = NULL, last_error_message = NULL, updated_at = ?
				WHERE mapping_key = ?
					AND operation_kind = 'discord.issue.lifecycle'
					AND state = 'dead'
					AND last_error_code = 'THREAD_PENDING'
			`,
			args: [now, now, mappingKey]
		});
		return result.rowsAffected;
	}

	public async redactCompletedPayloads(before: number, now = Date.now()) {
		const placeholder = JSON.stringify({ redacted: true });
		const [inbox, outbox] = await Promise.all([
			this.client.execute({
				sql: `
					UPDATE inbox_events SET payload_json = ?, redacted_at = ?, updated_at = ?
					WHERE state = 'completed' AND processed_at < ? AND redacted_at IS NULL
				`,
				args: [placeholder, now, now, before]
			}),
			this.client.execute({
				sql: `
					UPDATE outbox_operations SET payload_json = ?, result_json = NULL, redacted_at = ?, updated_at = ?
					WHERE state = 'completed' AND completed_at < ? AND redacted_at IS NULL
				`,
				args: [placeholder, now, now, before]
			})
		]);
		return inbox.rowsAffected + outbox.rowsAffected;
	}

	private async finishClaim(table: "inbox_events", id: string, owner: string, state: JobState, now: number) {
		const result = await this.client.execute({
			sql: `
				UPDATE ${table}
				SET state = ?, processed_at = ?, claim_owner = NULL, claim_expires_at = NULL,
					last_error_code = NULL, last_error_message = NULL, updated_at = ?
				WHERE id = ? AND state = 'processing' AND claim_owner = ?
			`,
			args: [state, now, now, id, owner]
		});
		return result.rowsAffected === 1;
	}

	private async failClaim(
		table: "inbox_events" | "outbox_operations",
		id: string,
		owner: string,
		failure: RelayFailure,
		decision: RetryDecision,
		now: number
	) {
		const nextAttemptAt = decision.state === "pending" ? now + (decision.delayMs ?? 0) : null;
		const result = await this.client.execute({
			sql: `
				UPDATE ${table}
				SET state = ?, next_attempt_at = ?, claim_owner = NULL, claim_expires_at = NULL,
					last_error_code = ?, last_error_message = ?, updated_at = ?
				WHERE id = ? AND state = 'processing' AND claim_owner = ?
			`,
			args: [decision.state, nextAttemptAt, failure.code, failure.message, now, id, owner]
		});
		return result.rowsAffected === 1;
	}
}

function toClaimedJob(row: Row): ClaimedJob {
	return {
		attemptCount: requiredNumber(row.attempt_count, "attempt_count"),
		correlationId: requiredString(row.correlation_id, "correlation_id"),
		eventKind: requiredString(row.event_kind, "event_kind"),
		id: requiredString(row.id, "id"),
		mappingKey: optionalString(row.mapping_key),
		partitionKey: optionalString(row.partition_key),
		payload: parseJson(requiredString(row.payload_json, "payload_json")),
		platform: requiredPlatform(row.platform)
	};
}

function toClaimedOperation(row: Row): ClaimedOperation {
	const platform = requiredPlatform(row.platform);
	if (platform === "system") {
		throw new Error("An outbox operation cannot target the system platform.");
	}

	return {
		attemptCount: requiredNumber(row.attempt_count, "attempt_count"),
		correlationId: requiredString(row.correlation_id, "correlation_id"),
		expectedSourceRevision: optionalString(row.expected_source_revision),
		id: requiredString(row.id, "id"),
		mappingKey: requiredString(row.mapping_key, "mapping_key"),
		operationKind: requiredString(row.operation_kind, "operation_kind"),
		partitionKey: requiredString(row.partition_key, "partition_key"),
		payload: parseJson(requiredString(row.payload_json, "payload_json")),
		platform,
		relayItemId: optionalString(row.relay_item_id)
	};
}

function requiredPlatform(value: InValue): JobPlatform {
	if (value === "discord" || value === "github" || value === "media" || value === "system") {
		return value;
	}

	throw new Error(`Invalid job platform ${String(value)}.`);
}

function requiredString(value: InValue, field: string) {
	if (typeof value !== "string") {
		throw new Error(`Expected ${field} to be a string.`);
	}
	return value;
}

function optionalString(value: InValue) {
	return typeof value === "string" ? value : undefined;
}

function requiredNumber(value: InValue, field: string) {
	if (typeof value !== "number") {
		throw new Error(`Expected ${field} to be a number.`);
	}
	return value;
}
