import type { JsonValue } from "@/core/json.js";
import type { DiagnosticValue, Logger } from "@/core/logger.js";
import type { ClaimedJob, ClaimedOperation, JobRepository } from "@/db/job-repository.js";
import { normalizeFailure, retryDecision } from "@/jobs/retry-policy.js";

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_CLAIM_DURATION_MS = 60_000;

export type InboxHandler = (job: ClaimedJob) => Promise<void>;
export type OutboxHandler = (operation: ClaimedOperation) => Promise<DiagnosticValue>;

export interface DurableWorkerOptions {
	claimDurationMs?: number;
	inboxHandler: InboxHandler;
	instanceId: string;
	logger: Logger;
	outboxHandler: OutboxHandler;
	pollIntervalMs?: number;
	repository: JobRepository;
}

export class DurableWorker {
	readonly #claimDurationMs: number;
	readonly #inboxHandler: InboxHandler;
	readonly #instanceId: string;
	readonly #logger: Logger;
	readonly #outboxHandler: OutboxHandler;
	readonly #pollIntervalMs: number;
	readonly #repository: JobRepository;
	#active = false;
	#timer?: ReturnType<typeof setTimeout>;

	public constructor(options: DurableWorkerOptions) {
		this.#claimDurationMs = options.claimDurationMs ?? DEFAULT_CLAIM_DURATION_MS;
		this.#inboxHandler = options.inboxHandler;
		this.#instanceId = options.instanceId;
		this.#logger = options.logger;
		this.#outboxHandler = options.outboxHandler;
		this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.#repository = options.repository;
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
		if (!this.#active) {
			return;
		}

		try {
			const didInboxWork = await this.#processInbox();
			const didOutboxWork = await this.#processOutbox();
			this.#schedule(didInboxWork || didOutboxWork ? 0 : this.#pollIntervalMs);
		} catch (error) {
			const failure = normalizeFailure(error instanceof Error ? error : new Error(String(error)));
			this.#logger.error("Durable worker polling failed.", { error: failure });
			this.#schedule(this.#pollIntervalMs);
		}
	}

	async #processInbox() {
		const job = await this.#repository.claimInbox(this.#instanceId, this.#claimDurationMs);
		if (!job) {
			return false;
		}

		try {
			await this.#inboxHandler(job);
			await this.#repository.completeInbox(job.id, this.#instanceId);
		} catch (error) {
			const failure = normalizeFailure(error instanceof Error ? error : new Error(String(error)));
			await this.#repository.failInbox(job.id, this.#instanceId, failure, retryDecision(failure, job.attemptCount));
			this.#logger.warn("Inbox event failed.", {
				correlationId: job.correlationId,
				error: failure,
				eventId: job.id,
				eventKind: job.eventKind,
				mappingKey: job.mappingKey,
				platform: job.platform
			});
		}
		return true;
	}

	async #processOutbox() {
		const operation = await this.#repository.claimOutbox(this.#instanceId, this.#claimDurationMs);
		if (!operation) {
			return false;
		}

		try {
			const result = await this.#outboxHandler(operation);
			await this.#repository.completeOutbox(operation.id, this.#instanceId, toJsonCompatible(result));
		} catch (error) {
			const failure = normalizeFailure(error instanceof Error ? error : new Error(String(error)));
			await this.#repository.failOutbox(operation.id, this.#instanceId, failure, retryDecision(failure, operation.attemptCount));
			this.#logger.warn("Outbox operation failed.", {
				correlationId: operation.correlationId,
				error: failure,
				mappingKey: operation.mappingKey,
				operationId: operation.id,
				operationKind: operation.operationKind,
				platform: operation.platform
			});
		}
		return true;
	}

	#schedule(delayMs: number) {
		if (!this.#active) {
			return;
		}
		this.#timer = setTimeout(() => void this.#tick(), delayMs);
	}
}

function toJsonCompatible(value: DiagnosticValue): JsonValue {
	const result: JsonValue = JSON.parse(JSON.stringify(value));
	return result;
}
