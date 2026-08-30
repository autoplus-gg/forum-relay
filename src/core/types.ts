import type {
	Client,
	GatewayDispatchEvents,
	GatewayInteractionCreateDispatchData,
	GatewayReadyDispatchData,
	ToEventProps
} from "@discordjs/core";
import type { Client as DatabaseClient } from "@libsql/client";
import type {
	APIChatInputApplicationCommandInteraction,
	APIMessageComponentInteraction,
	RESTPostAPIChatInputApplicationCommandsJSONBody
} from "discord-api-types/v10";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { BootstrapService } from "@/bootstrap/service.js";
import type { NormalizedConfig } from "@/config/normalize.js";
import type { Logger } from "@/core/logger.js";
import type { HandlerRegistry } from "@/core/registry.js";
import type { InteractionRouter } from "@/core/router.js";
import type { JobRepository } from "@/db/job-repository.js";
import type * as schema from "@/db/schema.js";
import type { ReconciliationService } from "@/reconciliation/service.js";

export interface BotApp {
	applicationId: string;
	bootstrap: BootstrapService;
	client: Client;
	config: NormalizedConfig;
	databaseClient: DatabaseClient;
	db: LibSQLDatabase<typeof schema>;
	discordToken: string;
	logger: Logger;
	jobs: JobRepository;
	registry: HandlerRegistry;
	reconciliation: ReconciliationService;
	router: InteractionRouter;
}

export interface CommandModule {
	data: RESTPostAPIChatInputApplicationCommandsJSONBody;
	execute(app: BotApp, interaction: APIChatInputApplicationCommandInteraction): Promise<void>;
}

export interface ComponentHandler {
	execute(app: BotApp, interaction: APIMessageComponentInteraction, state: string[]): Promise<void>;
}

export interface FeatureModule {
	key: string;
	components?: Readonly<Record<string, ComponentHandler>>;
}

export interface ReadyEventModule {
	name: GatewayDispatchEvents.Ready;
	once?: boolean;
	execute(app: BotApp, event: ToEventProps<GatewayReadyDispatchData>): Promise<void>;
}

export interface InteractionCreateEventModule {
	name: GatewayDispatchEvents.InteractionCreate;
	once?: boolean;
	execute(app: BotApp, event: ToEventProps<GatewayInteractionCreateDispatchData>): Promise<void>;
}

export type EventModule = ReadyEventModule | InteractionCreateEventModule;
