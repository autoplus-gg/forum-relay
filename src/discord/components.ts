import type { RawFile } from "@discordjs/rest";
import { type APIMessageTopLevelComponent, ComponentType, MessageFlags, SeparatorSpacingSize } from "discord-api-types/v10";

export interface DiscordRenderPayload {
	avatarUrl?: string;
	components: APIMessageTopLevelComponent[];
	files?: RawFile[];
	username: string;
}

export function textComponents(content: string, jumpUrl?: string): APIMessageTopLevelComponent[] {
	const components: APIMessageTopLevelComponent[] = [
		{
			type: ComponentType.TextDisplay,
			content
		}
	];

	if (jumpUrl) {
		components.push(
			{
				type: ComponentType.Separator,
				divider: true,
				spacing: SeparatorSpacingSize.Small
			},
			{
				type: ComponentType.TextDisplay,
				content: `[Jump to the original message](${escapeMarkdownUrl(jumpUrl)})`
			}
		);
	}
	return components;
}

export function webhookMessageBody(payload: DiscordRenderPayload) {
	return {
		allowed_mentions: { parse: [] },
		avatar_url: payload.avatarUrl,
		components: payload.components,
		files: payload.files,
		flags: MessageFlags.IsComponentsV2,
		username: payload.username
	};
}

function escapeMarkdownUrl(url: string) {
	return url.replaceAll(")", "%29");
}
