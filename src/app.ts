import { hostname } from "node:os";
import { Client, GatewayIntentBits } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import { BootstrapService } from "@/bootstrap/service.js";
import { normalizeConfig } from "@/config/normalize.js";
import { discoverCommands, discoverEvents, discoverFeatures } from "@/core/discovery.js";
import type { RuntimeEnvironment } from "@/core/environment.js";
import { createLogger } from "@/core/logger.js";
import { createHandlerRegistry, registerEvents } from "@/core/registry.js";
import { InteractionRouter } from "@/core/router.js";
import type { BotApp } from "@/core/types.js";
import { createPreMigrationBackup } from "@/db/backups.js";
import { createDatabase } from "@/db/client.js";
import { JobRepository } from "@/db/job-repository.js";
import { MappingRepository } from "@/db/mapping-repository.js";
import { RelayRepository } from "@/db/relay-repository.js";
import { DiscordClient } from "@/discord/client.js";
import { DiscordEventIntake } from "@/discord/intake.js";
import { GitHubClient } from "@/github/client.js";
import { type ReadinessState, RelayHttpServer } from "@/http/server.js";
import { AuditClassifier } from "@/jobs/audit-classifier.js";
import { DurableWorker } from "@/jobs/durable-worker.js";
import { MaintenanceScheduler } from "@/jobs/maintenance.js";
import { RecoveryScheduler } from "@/jobs/recovery-scheduler.js";
import { WorkerLease } from "@/jobs/worker-lease.js";
import { GitHubMediaDownloader } from "@/media/github-download.js";
import { DiscordMediaProxy } from "@/media/ticketpm.js";
import { ReconciliationService } from "@/reconciliation/service.js";
import { RelayEngine } from "@/relay/engine.js";
import config from "../config/config.js";

export async function createBotApp(environment: RuntimeEnvironment) {
	const logger = createLogger("bot", { level: environment.logLevel });
	const normalizedConfig = normalizeConfig(config);
	createPreMigrationBackup(environment.databaseUrl, logger);
	const database = await createDatabase(environment, logger);
	const jobs = new JobRepository(database.client);
	const mappings = new MappingRepository(database.client);
	const relay = new RelayRepository(database.client);
	const rest = new REST({ version: "10" }).setToken(environment.discordToken);
	const gateway = new WebSocketManager({
		token: environment.discordToken,
		intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent,
		rest
	});
	const client = new Client({ rest, gateway });
	const [commands, events, features] = await Promise.all([
		discoverCommands(logger),
		discoverEvents(logger),
		discoverFeatures(logger)
	]);
	const registry = createHandlerRegistry({ commands, events, features, logger });
	let router: InteractionRouter;
	let bootstrap: BootstrapService;
	let reconciliation: ReconciliationService;
	const app: BotApp = {
		applicationId: normalizedConfig.clientId,
		get bootstrap() {
			return bootstrap;
		},
		client,
		config: normalizedConfig,
		databaseClient: database.client,
		db: database.db,
		discordToken: environment.discordToken,
		jobs,
		logger,
		get reconciliation() {
			return reconciliation;
		},
		registry,
		get router() {
			return router;
		}
	};

	router = new InteractionRouter(app);
	registerEvents(app);
	let connected = false;
	let active = false;
	const instanceId = crypto.randomUUID();
	const readiness: ReadinessState = {
		database: true,
		discord: false,
		github: false,
		lease: false
	};
	const discord = new DiscordClient(client, database.client, normalizedConfig, logger.child({ adapter: "discord" }));
	const github = new GitHubClient(environment, normalizedConfig, database.client, logger.child({ adapter: "github" }));
	bootstrap = new BootstrapService({
		config: normalizedConfig,
		database: database.client,
		discord,
		github,
		jobs,
		logger: logger.child({ component: "bootstrap" })
	});
	reconciliation = new ReconciliationService({
		config: normalizedConfig,
		database: database.client,
		discord,
		github,
		jobs,
		logger: logger.child({ component: "reconciliation" }),
		relay
	});
	const recovery = new RecoveryScheduler({
		config: normalizedConfig.maintenance,
		github,
		logger: logger.child({ component: "recovery" }),
		reconciliation
	});
	const media = new DiscordMediaProxy(environment.ticketPmToken);
	const githubMedia = new GitHubMediaDownloader({
		authorizationFor: (mappingKey) => github.mediaAuthorization(mappingKey)
	});
	const engine = new RelayEngine({
		config: normalizedConfig,
		discord,
		github,
		githubMedia,
		jobs,
		logger: logger.child({ component: "relay-engine" }),
		media,
		relay
	});
	const worker = new DurableWorker({
		inboxHandler: (job) => engine.processInbox(job),
		instanceId,
		logger: logger.child({ component: "durable-worker" }),
		outboxHandler: (operation) => engine.processOutbox(operation),
		repository: jobs
	});
	const auditClassifier = new AuditClassifier({
		applicationId: normalizedConfig.clientId,
		database: database.client,
		discord,
		jobs,
		logger: logger.child({ component: "audit-classifier" }),
		relay
	});
	const maintenance = new MaintenanceScheduler({
		client: database.client,
		config: normalizedConfig.maintenance,
		databaseUrl: environment.databaseUrl,
		jobs,
		logger: logger.child({ component: "maintenance" })
	});
	const http = new RelayHttpServer({
		config: normalizedConfig,
		environment,
		jobs,
		logger: logger.child({ component: "http" }),
		readiness
	});
	new DiscordEventIntake(
		client,
		database.client,
		normalizedConfig,
		jobs,
		logger.child({ component: "discord-intake" })
	).register();

	async function deactivate() {
		if (!active) {
			return;
		}
		active = false;
		readiness.discord = false;
		readiness.github = false;
		readiness.lease = false;
		worker.stop();
		auditClassifier.stop();
		maintenance.stop();
		bootstrap.stop();
		recovery.stop();
		http.stop();
		if (connected) {
			connected = false;
			await gateway.destroy();
		}
	}

	const lease = new WorkerLease({
		client: database.client,
		hostLabel: hostname(),
		instanceId,
		logger,
		onLeaseLost: deactivate
	});
	let stopPromise: Promise<void> | undefined;

	function stopOnce() {
		return (async () => {
			let shutdownError: Error | undefined;
			const deactivation = deactivate().catch((error) => {
				shutdownError = error instanceof Error ? error : new Error(String(error));
			});
			const release = lease.release().catch((error) => {
				shutdownError ??= error instanceof Error ? error : new Error(String(error));
			});

			await Promise.all([deactivation, release]);
			database.close();
			if (shutdownError) {
				throw shutdownError;
			}
		})();
	}

	return {
		app,
		async start() {
			logger.info(`Loaded ${registry.features.size} features and ${registry.commands.size} commands.`);
			if (!(await lease.acquireEventually())) {
				logger.warn("Another Forum Relay process still owns the worker lease after the startup wait; remaining inactive.");
				return;
			}
			active = true;
			readiness.lease = true;
			await mappings.applyConfig(normalizedConfig);

			const githubMappings = await github.initializeMappings();
			readiness.github = [...githubMappings.values()].some((result) => !(result instanceof Error));
			const discordMappings = await discord.initializeMappings();
			readiness.discord = [...discordMappings.values()].some((result) => !(result instanceof Error));

			for (const mappingKey of Object.keys(normalizedConfig.mappings)) {
				const githubMapping = githubMappings.get(mappingKey);
				const discordMapping = discordMappings.get(mappingKey);
				if (githubMapping instanceof Error) {
					logger.warn("GitHub mapping initialization failed; automatic label/tag synchronization was skipped.", {
						discordError: discordMapping instanceof Error ? discordMapping : undefined,
						githubError: githubMapping,
						mappingKey
					});
					continue;
				}
				if (discordMapping instanceof Error) {
					// Forum tags use the bot-authenticated channel API and remain
					// available even if the message webhook is temporarily unusable.
					logger.warn("Discord webhook initialization failed; continuing label/tag synchronization.", {
						discordError: discordMapping,
						mappingKey
					});
				}
				try {
					const mapping = normalizedConfig.mappings[mappingKey];
					if (!mapping) {
						continue;
					}
					const bootstrapState = await database.client.execute({
						sql: "SELECT bootstrap_completed_at FROM mappings WHERE key = ?",
						args: [mappingKey]
					});
					const seedLabelNames =
						mapping.bootstrap.source === "discord" && bootstrapState.rows[0]?.bootstrap_completed_at == null
							? await discord.forumTagNames(mappingKey)
							: [];
					await github.syncLabels(mappingKey, seedLabelNames);
					await discord.syncForumTags(mappingKey);
					if (!(discordMapping instanceof Error)) {
						await database.client.execute({
							sql: `
								UPDATE mappings SET state = CASE
									WHEN state IN ('BOOTSTRAPPING', 'PAUSED') THEN state
									WHEN bootstrap_completed_at IS NULL THEN 'PENDING_BOOTSTRAP' ELSE 'ACTIVE'
								END, last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE key = ?
							`,
							args: [Date.now(), mappingKey]
						});
					}
				} catch (error) {
					logger.warn("Label/tag initialization degraded a mapping.", {
						error: error instanceof Error ? error : String(error),
						mappingKey
					});
				}
			}

			http.start();
			worker.start();
			auditClassifier.start();
			maintenance.start();
			await gateway.connect();
			connected = true;
			await bootstrap.resumeRunning();
			recovery.start();
		},
		stop() {
			stopPromise ??= stopOnce();
			return stopPromise;
		}
	};
}
