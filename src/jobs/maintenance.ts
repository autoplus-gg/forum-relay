import type { Client } from "@libsql/client";
import type { NormalizedMaintenanceConfig } from "@/config/normalize.js";
import type { Logger } from "@/core/logger.js";
import { createConsistentBackup } from "@/db/backups.js";
import type { JobRepository } from "@/db/job-repository.js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export interface MaintenanceSchedulerOptions {
	client: Client;
	config: NormalizedMaintenanceConfig;
	databaseUrl: string;
	jobs: JobRepository;
	logger: Logger;
}

export class MaintenanceScheduler {
	readonly #options: MaintenanceSchedulerOptions;
	#active = false;
	#timer?: ReturnType<typeof setTimeout>;

	public constructor(options: MaintenanceSchedulerOptions) {
		this.#options = options;
	}

	public start() {
		if (this.#active) {
			return;
		}
		this.#active = true;
		void this.#run().finally(() => this.#schedule());
	}

	public stop() {
		this.#active = false;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	async #run() {
		try {
			await this.#backupIfDue();
			const retentionBoundary = Date.now() - this.#options.config.processedPayloadRetentionDays * DAY_MS;
			const redacted = await this.#options.jobs.redactCompletedPayloads(retentionBoundary);
			if (redacted > 0) {
				this.#options.logger.info("Redacted expired processed payloads.", { count: redacted });
			}
		} catch (error) {
			this.#options.logger.error("Maintenance run failed.", {
				error: error instanceof Error ? error : String(error)
			});
		}
	}

	async #backupIfDue() {
		const previous = await this.#options.client.execute({
			sql: `
				SELECT started_at FROM maintenance_runs
				WHERE kind = 'DAILY_BACKUP' AND state = 'COMPLETED'
				ORDER BY started_at DESC LIMIT 1
			`
		});
		const lastStartedAt = Number(previous.rows[0]?.started_at ?? 0);
		if (Date.now() - lastStartedAt < DAY_MS) {
			return;
		}

		const id = crypto.randomUUID();
		const now = Date.now();
		await this.#options.client.execute({
			sql: `
				INSERT INTO maintenance_runs (id, kind, state, started_at, created_at, updated_at)
				VALUES (?, 'DAILY_BACKUP', 'RUNNING', ?, ?, ?)
			`,
			args: [id, now, now, now]
		});
		const result = await createConsistentBackup({
			client: this.#options.client,
			databaseUrl: this.#options.databaseUrl,
			logger: this.#options.logger,
			retainCount: this.#options.config.localBackupCount
		});
		await this.#options.client.execute({
			sql: `
				UPDATE maintenance_runs SET state = 'COMPLETED', details_json = ?,
					completed_at = ?, updated_at = ? WHERE id = ?
			`,
			args: [JSON.stringify(result ?? { providerManaged: true }), Date.now(), Date.now(), id]
		});
	}

	#schedule() {
		if (!this.#active) {
			return;
		}
		this.#timer = setTimeout(() => void this.#run().finally(() => this.#schedule()), HOUR_MS);
	}
}
