import type { JsonObject } from "@/core/json.js";
import { isJsonObject } from "@/core/json.js";

interface DiscordMessageOrigin {
	application_id?: string | null;
	author?: {
		bot?: boolean;
		id: string;
	};
	interaction_metadata?: object | null;
	webhook_id?: string;
}

export function shouldIgnoreDiscordMessage(message: DiscordMessageOrigin, clientId: string) {
	// Forum Relay imports human-authored messages only. Reject every webhook,
	// not just the currently cached relay webhook ID, because a webhook-created
	// message may reach the Gateway while webhook ownership is being refreshed.
	return Boolean(
		message.webhook_id ||
			message.interaction_metadata ||
			message.author?.bot ||
			message.author?.id === clientId ||
			message.application_id === clientId
	);
}

export function shouldIgnoreStoredDiscordMessage(message: JsonObject, clientId: string) {
	const author = message.author && isJsonObject(message.author) ? message.author : undefined;
	const authorId = typeof author?.id === "string" ? author.id : undefined;
	return shouldIgnoreDiscordMessage(
		{
			application_id: typeof message.application_id === "string" ? message.application_id : undefined,
			author: authorId
				? {
						bot: author?.bot === true,
						id: authorId
					}
				: undefined,
			interaction_metadata: isJsonObject(message.interaction_metadata) ? message.interaction_metadata : undefined,
			webhook_id: typeof message.webhook_id === "string" ? message.webhook_id : undefined
		},
		clientId
	);
}
