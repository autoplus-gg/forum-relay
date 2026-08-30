import type { Client } from "@libsql/client";
import type { Logger } from "@/core/logger.js";

const LEASE_NAME = "forum-relay-worker";
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RENEW_INTERVAL_MS = 10_000;
const DEFAULT_ACQUIRE_RETRY_MS = 1_000;
const DEFAULT_ACQUIRE_WAIT_MS = DEFAULT_LEASE_DURATION_MS + 5_000;

export interface WorkerLeaseOptions {
	client: Client;
	hostLabel: string;
	instanceId: string;
	logger: Logger;
	onLeaseLost(): Promise<void>;
	leaseDurationMs?: number;
	renewIntervalMs?: number;
}

export class WorkerLease {
	readonly #client: Client;
	readonly #hostLabel: string;
	readonly #instanceId: string;
	readonly #leaseDurationMs: number;
	readonly #logger: Logger;
	readonly #onLeaseLost: () => Promise<void>;
	readonly #renewIntervalMs: number;
	#active = false;
	#renewTimer?: ReturnType<typeof setInterval>;

	public constructor(options: WorkerLeaseOptions) {
		this.#client = options.client;
		this.#hostLabel = options.hostLabel;
		this.#instanceId = options.instanceId;
		this.#leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
		this.#logger = options.logger;
		this.#onLeaseLost = options.onLeaseLost;
		this.#renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
	}

	public get active() {
		return this.#active;
	}

	public async acquire() {
		const now = Date.now();
		const expiresAt = now + this.#leaseDurationMs;

		await this.#client.execute({
			sql: `
				INSERT INTO worker_leases (
					name, instance_id, host_label, acquired_at, renewed_at, expires_at
				) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(name) DO UPDATE SET
					instance_id = excluded.instance_id,
					host_label = excluded.host_label,
					acquired_at = excluded.acquired_at,
					renewed_at = excluded.renewed_at,
					expires_at = excluded.expires_at
				WHERE worker_leases.expires_at <= ?
					OR worker_leases.instance_id = excluded.instance_id
			`,
			args: [LEASE_NAME, this.#instanceId, this.#hostLabel, now, now, expiresAt, now]
		});

		const result = await this.#client.execute({
			sql: "SELECT instance_id FROM worker_leases WHERE name = ?",
			args: [LEASE_NAME]
		});
		this.#active = result.rows[0]?.instance_id === this.#instanceId;

		if (this.#active) {
			this.#startRenewal();
			this.#logger.info(`Acquired worker lease as ${this.#instanceId}.`);
		}

		return this.#active;
	}

	public async acquireEventually(maxWaitMs = DEFAULT_ACQUIRE_WAIT_MS, retryIntervalMs = DEFAULT_ACQUIRE_RETRY_MS) {
		const deadline = Date.now() + maxWaitMs;
		let waiting = false;
		for (;;) {
			if (await this.acquire()) {
				return true;
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}
			if (!waiting) {
				waiting = true;
				this.#logger.warn("Worker lease is held; waiting for a potentially stale lease to expire.", { maxWaitMs });
			}
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(retryIntervalMs, remainingMs)));
		}
	}

	public async release() {
		this.#stopRenewal();

		if (!this.#active) {
			return;
		}

		this.#active = false;
		await this.#client.execute({
			sql: "DELETE FROM worker_leases WHERE name = ? AND instance_id = ?",
			args: [LEASE_NAME, this.#instanceId]
		});
		this.#logger.info("Released worker lease.");
	}

	async #renew() {
		if (!this.#active) {
			return;
		}

		const now = Date.now();
		const result = await this.#client.execute({
			sql: `
				UPDATE worker_leases
				SET renewed_at = ?, expires_at = ?
				WHERE name = ? AND instance_id = ? AND expires_at > ?
			`,
			args: [now, now + this.#leaseDurationMs, LEASE_NAME, this.#instanceId, now]
		});

		if (result.rowsAffected === 1) {
			return;
		}

		this.#active = false;
		this.#stopRenewal();
		this.#logger.error("Worker lease was lost; stopping active services.");
		await this.#onLeaseLost();
	}

	#startRenewal() {
		this.#stopRenewal();
		this.#renewTimer = setInterval(() => {
			void this.#renew().catch(async () => {
				this.#active = false;
				this.#stopRenewal();
				this.#logger.error("Worker lease renewal failed; stopping active services.");
				await this.#onLeaseLost();
			});
		}, this.#renewIntervalMs);
	}

	#stopRenewal() {
		if (this.#renewTimer) {
			clearInterval(this.#renewTimer);
			this.#renewTimer = undefined;
		}
	}
}
