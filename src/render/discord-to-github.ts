export interface DiscordAttachment {
	contentType?: string;
	filename: string;
	proxyUrl?: string;
	size: number;
	state?: "complete" | "failed" | "pending";
	url: string;
}

export interface DiscordAuthor {
	avatarUrl?: string;
	displayName: string;
	id: string;
	username: string;
}

export interface DiscordRenderContext {
	channels: Readonly<Record<string, string>>;
	guildId: string;
	roles: Readonly<Record<string, string>>;
	threadId: string;
	users: Readonly<Record<string, string>>;
}

export interface DiscordToGitHubInput {
	attachments: readonly DiscordAttachment[];
	author: DiscordAuthor;
	content: string;
	context: DiscordRenderContext;
	messageId: string;
	replyTo?: {
		authorName: string;
		content: string;
		jumpUrl: string;
	};
}

const RELAY_MARKER_VERSION = 1;
const ZERO_WIDTH = "\u200B";

export function renderDiscordToGitHub(input: DiscordToGitHubInput) {
	const lines: string[] = [];
	if (input.author.avatarUrl) {
		lines.push(
			`<img src="${escapeHtmlAttribute(input.author.avatarUrl)}" width="24" height="24" alt=""> ` +
				`**${escapeInline(input.author.username)}** ` +
				`*(Proxied from @${ZERO_WIDTH}${escapeInline(input.author.username)} ` +
				`(${escapeInline(input.author.displayName)}) (${input.author.id}))*`
		);
	} else {
		lines.push(
			`**${escapeInline(input.author.username)}** *(Proxied from @${ZERO_WIDTH}${escapeInline(input.author.username)} ` +
				`(${escapeInline(input.author.displayName)}) (${input.author.id}))*`
		);
	}

	if (input.replyTo) {
		const preview = input.replyTo.content.replaceAll(/\s+/g, " ").slice(0, 240);
		lines.push(
			`> Replying to [${escapeInline(input.replyTo.authorName)}](${escapeMarkdownUrl(input.replyTo.jumpUrl)}): ` +
				`${escapeInline(preview)}`
		);
	}

	const content = transformDiscordTokens(stripRelayMarkers(input.content), input.context);
	lines.push(content || "_No text content._");

	for (const attachment of input.attachments) {
		if (attachment.state === "pending") {
			lines.push(`_Attachment \`${escapeInline(attachment.filename)}\` is being proxied…_`);
			continue;
		}
		if (attachment.state === "failed") {
			lines.push(
				`_Attachment \`${escapeInline(attachment.filename)}\` could not be proxied. ` +
					`[View the Discord message](${jumpUrl(input)})._`
			);
			continue;
		}
		const url = attachment.proxyUrl ?? attachment.url;
		if (attachment.contentType?.startsWith("image/")) {
			lines.push(`![${escapeInline(attachment.filename)}](${escapeMarkdownUrl(url)})`);
		} else {
			lines.push(`[${escapeInline(attachment.filename)}](${escapeMarkdownUrl(url)}) (${formatBytes(attachment.size)})`);
		}
	}

	lines.push(`[Jump to Discord's message](${jumpUrl(input)})`);
	lines.push(`<!-- forum-relay:v${RELAY_MARKER_VERSION}:discord-message:${input.messageId} -->`);
	return lines.filter(Boolean).join("\n\n");
}

function jumpUrl(input: DiscordToGitHubInput) {
	return `https://discord.com/channels/${input.context.guildId}/${input.context.threadId}/${input.messageId}`;
}

function transformDiscordTokens(content: string, context: DiscordRenderContext) {
	return splitCodeAware(content)
		.map((part) => (part.code ? part.value : transformText(part.value, context)))
		.join("");
}

function transformText(value: string, context: DiscordRenderContext) {
	return value
		.replaceAll(/<@!?(\d{17,20})>/g, (_token, id: string) => nonNotifying(context.users[id] ?? id))
		.replaceAll(/<@&(\d{17,20})>/g, (_token, id: string) => nonNotifying(context.roles[id] ?? id))
		.replaceAll(/<#(\d{17,20})>/g, (_token, id: string) => `#${context.channels[id] ?? id}`)
		.replaceAll(/<a?:([a-zA-Z0-9_]+):\d{17,20}>/g, ":$1:")
		.replaceAll(/<t:(\d{1,12})(?::[tTdDfFR])?>/g, (_token, seconds: string) => new Date(Number(seconds) * 1_000).toISOString())
		.replaceAll("@everyone", `@${ZERO_WIDTH}everyone`)
		.replaceAll("@here", `@${ZERO_WIDTH}here`);
}

function splitCodeAware(value: string) {
	const parts: { code: boolean; value: string }[] = [];
	let cursor = 0;
	const pattern = /```[\s\S]*?```|`[^`\n]+`/g;
	for (const match of value.matchAll(pattern)) {
		const index = match.index;
		if (index > cursor) {
			parts.push({ code: false, value: value.slice(cursor, index) });
		}
		parts.push({ code: true, value: match[0] });
		cursor = index + match[0].length;
	}
	if (cursor < value.length) {
		parts.push({ code: false, value: value.slice(cursor) });
	}
	return parts;
}

function nonNotifying(value: string) {
	return `@${ZERO_WIDTH}${value.replace(/^@/, "")}`;
}

function stripRelayMarkers(value: string) {
	return value.replaceAll(/<!--\s*forum-relay:[\s\S]*?-->/gi, "");
}

function escapeInline(value: string) {
	return value.replaceAll(/([\\`*_[\]()<>])/g, "\\$1");
}

function escapeMarkdownUrl(value: string) {
	return value.replaceAll("(", "%28").replaceAll(")", "%29").replaceAll(" ", "%20");
}

function escapeHtmlAttribute(value: string) {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatBytes(value: number) {
	if (value < 1_024) {
		return `${value} B`;
	}
	if (value < 1_048_576) {
		return `${(value / 1_024).toFixed(1)} KiB`;
	}
	return `${(value / 1_048_576).toFixed(1)} MiB`;
}
