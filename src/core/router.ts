import type {
	APIApplicationCommandInteraction,
	APIChatInputApplicationCommandInteraction,
	APIInteraction
} from "@discordjs/core";
import { ApplicationCommandType, InteractionType } from "@discordjs/core";
import { parseCustomId } from "@/core/custom-id.js";
import { respondEphemeral } from "@/core/respond.js";
import type { BotApp } from "@/core/types.js";

export class InteractionRouter {
	public constructor(private readonly app: BotApp) {}

	public async handleInteraction(interaction: APIInteraction) {
		if (interaction.type === InteractionType.ApplicationCommand) {
			if (!isChatInputCommand(interaction)) {
				return;
			}

			const command = this.app.registry.commands.get(interaction.data.name);

			if (!command) {
				await respondEphemeral(this.app, interaction, {
					content: "This command is not available."
				});
				return;
			}

			await command.execute(this.app, interaction);
			return;
		}

		if (interaction.type !== InteractionType.MessageComponent) {
			return;
		}

		const customId = parseCustomId(interaction.data.custom_id);
		const handler = customId ? this.app.registry.features.get(customId.featureKey)?.components?.[customId.action] : undefined;

		if (!customId || !handler) {
			await respondEphemeral(this.app, interaction, {
				content: "This action is no longer available."
			});
			return;
		}

		await handler.execute(this.app, interaction, customId.state);
	}
}

function isChatInputCommand(
	interaction: APIApplicationCommandInteraction
): interaction is APIChatInputApplicationCommandInteraction {
	return interaction.data.type === ApplicationCommandType.ChatInput;
}
