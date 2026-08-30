import { API } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord-api-types/v10";
import type { Logger } from "@/core/logger.js";

export async function deployApplicationCommands(options: {
	applicationCommands: RESTPostAPIChatInputApplicationCommandsJSONBody[];
	clientId: string;
	guildId: string;
	logger: Logger;
	token: string;
}) {
	const rest = new REST({ version: "10" }).setToken(options.token);
	const api = new API(rest);

	await api.applicationCommands.bulkOverwriteGuildCommands(options.clientId, options.guildId, options.applicationCommands);
	options.logger.info(`Deployed ${options.applicationCommands.length} guild commands to ${options.guildId}.`);
}
