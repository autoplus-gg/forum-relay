import { GatewayDispatchEvents, type GatewayReadyDispatchData, type ToEventProps } from "@discordjs/core";
import { ActivityType, type GatewayPresenceUpdateData, PresenceUpdateStatus } from "discord-api-types/v10";
import { defineEvent } from "@/core/defineEvent.js";
import type { BotApp } from "@/core/types.js";
import { deployApplicationCommands } from "@/deploy-commands.js";

const ACTIVITY_TYPES = {
	COMPETING: ActivityType.Competing,
	CUSTOM: ActivityType.Custom,
	LISTENING: ActivityType.Listening,
	PLAYING: ActivityType.Playing,
	STREAMING: ActivityType.Streaming,
	WATCHING: ActivityType.Watching
} as const;
const PRESENCE_STATUSES = {
	dnd: PresenceUpdateStatus.DoNotDisturb,
	idle: PresenceUpdateStatus.Idle,
	invisible: PresenceUpdateStatus.Invisible,
	online: PresenceUpdateStatus.Online
} as const;

const readyEvent = defineEvent({
	name: GatewayDispatchEvents.Ready,
	once: true,
	async execute(app, event: ToEventProps<GatewayReadyDispatchData>) {
		app.logger.info(`Connected as ${event.data.user.username}.`);
		await deployApplicationCommands({
			applicationCommands: app.registry.applicationCommands,
			clientId: app.config.clientId,
			guildId: app.config.guildId,
			logger: app.logger,
			token: app.discordToken
		});
		await applyConfiguredPresence(app);
	}
});

export default readyEvent;

async function applyConfiguredPresence(app: BotApp) {
	const configuredStatus = app.config.status;

	if (!configuredStatus?.enabled) {
		return;
	}

	const activities =
		configuredStatus.type && configuredStatus.text
			? [
					{
						name: configuredStatus.text,
						type: ACTIVITY_TYPES[configuredStatus.type],
						url: configuredStatus.type === "STREAMING" && configuredStatus.url?.trim() ? configuredStatus.url : undefined
					}
				]
			: [];
	const presence: GatewayPresenceUpdateData = {
		activities,
		afk: false,
		since: null,
		status: PRESENCE_STATUSES[configuredStatus.status]
	};
	const shardCount = await app.client.gateway.getShardCount();

	for (let shardId = 0; shardId < shardCount; shardId += 1) {
		await app.client.updatePresence(shardId, presence);
	}
}
