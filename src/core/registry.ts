import { GatewayDispatchEvents } from "@discordjs/core";
import type { Logger } from "@/core/logger.js";
import type { BotApp, CommandModule, EventModule, FeatureModule } from "@/core/types.js";

export interface HandlerRegistry {
	applicationCommands: CommandModule["data"][];
	commands: ReadonlyMap<string, CommandModule>;
	events: readonly EventModule[];
	features: ReadonlyMap<string, FeatureModule>;
}

export function createHandlerRegistry(options: {
	commands: CommandModule[];
	events: EventModule[];
	features: FeatureModule[];
	logger: Logger;
}): HandlerRegistry {
	const commands = new Map<string, CommandModule>();
	const features = new Map<string, FeatureModule>();

	for (const command of options.commands) {
		if (commands.has(command.data.name)) {
			throw new Error(`Duplicate command module "${command.data.name}".`);
		}
		commands.set(command.data.name, command);
	}

	for (const feature of options.features) {
		if (features.has(feature.key)) {
			throw new Error(`Duplicate feature module "${feature.key}".`);
		}
		features.set(feature.key, feature);
	}

	options.logger.info(`Registered ${commands.size} commands and ${features.size} features.`);

	return {
		applicationCommands: [...commands.values()].map((command) => command.data),
		commands,
		events: options.events,
		features
	};
}

export function registerEvents(app: BotApp) {
	for (const event of app.registry.events) {
		switch (event.name) {
			case GatewayDispatchEvents.Ready: {
				const subscribe = event.once ? app.client.once.bind(app.client) : app.client.on.bind(app.client);
				subscribe(GatewayDispatchEvents.Ready, (payload) => {
					void event.execute(app, payload);
				});
				break;
			}
			case GatewayDispatchEvents.InteractionCreate: {
				const subscribe = event.once ? app.client.once.bind(app.client) : app.client.on.bind(app.client);
				subscribe(GatewayDispatchEvents.InteractionCreate, (payload) => {
					void event.execute(app, payload);
				});
				break;
			}
		}
	}
}
