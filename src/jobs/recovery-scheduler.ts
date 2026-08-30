import type { NormalizedMaintenanceConfig } from "@/config/normalize.js";
import type { Logger } from "@/core/logger.js";
import type { GitHubClient } from "@/github/client.js";
import type { ReconciliationService } from "@/reconciliation/service.js";

export class RecoveryScheduler {
	readonly #config: NormalizedMaintenanceConfig;
	readonly #github: GitHubClient;
	readonly #logger: Logger;
	readonly #reconciliation: ReconciliationService;
	#active = false;
	#reconciliationTimer?: ReturnType<typeof setInterval>;
	#redeliveryTimer?: ReturnType<typeof setInterval>;

	public constructor(options: {
		config: NormalizedMaintenanceConfig;
		github: GitHubClient;
		logger: Logger;
		reconciliation: ReconciliationService;
	}) {
		this.#config = options.config;
		this.#github = options.github;
		this.#logger = options.logger;
		this.#reconciliation = options.reconciliation;
	}

	public start() {
		if (this.#active) {
			return;
		}
		this.#active = true;
		void this.#redeliver();
		void this.#reconciliation.startAllActive();
		this.#redeliveryTimer = setInterval(() => void this.#redeliver(), this.#config.failedWebhookDeliveryCheckMinutes * 60_000);
		this.#reconciliationTimer = setInterval(
			() => void this.#reconciliation.startAllActive(),
			this.#config.fullReconciliationIntervalHours * 60 * 60_000
		);
	}

	public stop() {
		this.#active = false;
		if (this.#redeliveryTimer) {
			clearInterval(this.#redeliveryTimer);
			this.#redeliveryTimer = undefined;
		}
		if (this.#reconciliationTimer) {
			clearInterval(this.#reconciliationTimer);
			this.#reconciliationTimer = undefined;
		}
	}

	async #redeliver() {
		try {
			const count = await this.#github.redeliverFailedWebhooks();
			if (count > 0) {
				// Requesting a redelivery is successful recovery work; individual
				// deliveries still enter the durable queue and report real failures there.
				this.#logger.info("Requested redelivery of failed GitHub App webhooks.", { count });
			}
		} catch (error) {
			this.#logger.error("Failed to inspect GitHub App webhook deliveries.", {
				error: error instanceof Error ? error : String(error)
			});
		}
	}
}
