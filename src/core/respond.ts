import type { CreateInteractionResponseOptions, EditInteractionResponseOptions } from "@discordjs/core";
import { MessageFlags } from "@discordjs/core";
import type { BotApp } from "@/core/types.js";

export async function deferEphemeral(app: BotApp, interaction: { id: string; token: string }) {
	await app.client.api.interactions.defer(interaction.id, interaction.token, {
		flags: MessageFlags.Ephemeral
	});
}

export async function editEphemeralResponse(app: BotApp, interaction: { token: string }, data: EditInteractionResponseOptions) {
	await app.client.api.interactions.editReply(app.applicationId, interaction.token, data);
}

export async function respondEphemeral(
	app: BotApp,
	interaction: { id: string; token: string },
	data: CreateInteractionResponseOptions
) {
	await app.client.api.interactions.reply(interaction.id, interaction.token, {
		...data,
		flags: MessageFlags.Ephemeral
	});
}
