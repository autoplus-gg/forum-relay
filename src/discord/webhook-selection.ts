export interface DiscordWebhookCandidate {
	application_id: string | null;
	channel_id: string | null;
	name: string | null;
	token?: string;
	user?: { id: string };
}

export function forumRelayWebhookName(mappingKey: string) {
	return `Forum Relay · ${mappingKey}`;
}

export function isReusableForumRelayWebhook(
	webhook: DiscordWebhookCandidate,
	clientId: string,
	channelId: string,
	mappingKey: string
) {
	const ownedByRelay = webhook.application_id === clientId || webhook.user?.id === clientId;
	const recognizedName = webhook.name === forumRelayWebhookName(mappingKey) || webhook.name === `Forum Relay Â· ${mappingKey}`;
	return ownedByRelay && recognizedName && webhook.channel_id === channelId && typeof webhook.token === "string";
}

export function isStoredForumRelayWebhook(webhook: DiscordWebhookCandidate, clientId: string, channelId: string) {
	return (
		(webhook.application_id === clientId || webhook.user?.id === clientId) &&
		webhook.channel_id === channelId &&
		typeof webhook.token === "string"
	);
}
