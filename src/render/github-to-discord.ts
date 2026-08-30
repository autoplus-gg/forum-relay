import type { RawFile } from "@discordjs/rest";
import {
	type APIMediaGalleryComponent,
	type APIMessageTopLevelComponent,
	ComponentType,
	SeparatorSpacingSize
} from "discord-api-types/v10";
import { isRecognizedGitHubMediaUrl } from "@/media/safe-download.js";
import { type MediaToken, parseGitHubMarkdown } from "@/render/markdown.js";

const MAX_TEXT_DISPLAY_LENGTH = 3_800;
const MAX_COMPONENTS_PER_MESSAGE = 35;
const MAX_FILES_PER_MESSAGE = 10;
const MAX_MEDIA_PER_GALLERY = 10;

interface ComponentEntry {
	component: APIMessageTopLevelComponent;
	files: RawFile[];
}

export interface GitHubRenderInput {
	authorAvatarUrl?: string;
	authorUsername: string;
	body: string;
	jumpUrl: string;
	mediaAttachments?: ReadonlyMap<string, RawFile>;
	repositoryUrl: string;
}

export interface DiscordRenderedSegment {
	avatarUrl?: string;
	components: APIMessageTopLevelComponent[];
	files: RawFile[];
	username: string;
}

export function renderGitHubToDiscord(input: GitHubRenderInput): DiscordRenderedSegment[] {
	const body = stripRelayMarkers(input.body);
	const { media } = parseGitHubMarkdown(body, input.repositoryUrl);
	const stream = buildComponentStream(body, media, input.mediaAttachments);
	appendJumpLink(stream, input.jumpUrl);
	const componentSegments = segmentComponents(stream);

	return componentSegments.map(({ components, files }) => ({
		avatarUrl: input.authorAvatarUrl,
		components,
		files,
		username: truncateGraphemes(input.authorUsername, 80)
	}));
}

function buildComponentStream(source: string, media: MediaToken[], mediaAttachments?: ReadonlyMap<string, RawFile>) {
	const components: ComponentEntry[] = [];
	let cursor = 0;

	for (const token of media) {
		appendText(components, source.slice(cursor, token.start));
		const isGitHubMedia = isRecognizedGitHubMediaUrl(token.url);
		const attachment = mediaAttachments?.get(token.url);
		if (attachment || (isGitHubMedia && !mediaAttachments)) {
			appendMedia(components, { ...token, url: attachment ? `attachment://${attachment.name}` : token.url }, attachment);
		} else {
			appendText(components, `[Image: ${token.alt || "external image"}](${token.url.replaceAll(")", "%29")})`);
		}
		cursor = token.end;
	}
	appendText(components, source.slice(cursor));

	if (components.length === 0) {
		appendText(components, "_No text content._");
	}
	return components;
}

function appendText(components: ComponentEntry[], text: string) {
	const normalized = text.trim();
	if (!normalized) {
		return;
	}
	for (const part of splitMarkdown(normalized, MAX_TEXT_DISPLAY_LENGTH)) {
		components.push({ component: { type: ComponentType.TextDisplay, content: part }, files: [] });
	}
}

function appendMedia(components: ComponentEntry[], media: MediaToken, attachment?: RawFile) {
	const previous = components.at(-1);
	if (previous?.component.type === ComponentType.MediaGallery && previous.component.items.length < MAX_MEDIA_PER_GALLERY) {
		previous.component.items.push({
			description: media.alt || undefined,
			media: { url: media.url }
		});
		if (attachment && !previous.files.some((file) => file.name === attachment.name)) {
			previous.files.push(attachment);
		}
		return;
	}

	const gallery: APIMediaGalleryComponent = {
		type: ComponentType.MediaGallery,
		items: [
			{
				description: media.alt || undefined,
				media: { url: media.url }
			}
		]
	};
	components.push({ component: gallery, files: attachment ? [attachment] : [] });
}

function appendJumpLink(components: ComponentEntry[], jumpUrl: string) {
	components.push(
		{
			component: {
				type: ComponentType.Separator,
				divider: true,
				spacing: SeparatorSpacingSize.Small
			},
			files: []
		},
		{
			component: {
				type: ComponentType.TextDisplay,
				content: `[Jump to GitHub's message](${jumpUrl.replaceAll(")", "%29")})`
			},
			files: []
		}
	);
}

function segmentComponents(entries: ComponentEntry[]) {
	const segments: { components: APIMessageTopLevelComponent[]; files: RawFile[] }[] = [];
	let components: APIMessageTopLevelComponent[] = [];
	let files = new Map<string, RawFile>();

	for (const entry of entries) {
		const newFiles = entry.files.filter((file) => !files.has(file.name));
		if (components.length >= MAX_COMPONENTS_PER_MESSAGE || files.size + newFiles.length > MAX_FILES_PER_MESSAGE) {
			segments.push({ components, files: [...files.values()] });
			components = [];
			files = new Map();
		}
		components.push(entry.component);
		for (const file of entry.files) {
			files.set(file.name, file);
		}
	}
	if (components.length > 0) {
		segments.push({ components, files: [...files.values()] });
	}
	return segments;
}

function splitMarkdown(value: string, limit: number) {
	const chunks: string[] = [];
	let remaining = value;
	while (remaining.length > limit) {
		const candidate = remaining.slice(0, limit);
		const newline = candidate.lastIndexOf("\n");
		const whitespace = candidate.lastIndexOf(" ");
		const splitAt = Math.max(newline, whitespace, Math.floor(limit * 0.6));
		chunks.push(balanceCodeFence(candidate.slice(0, splitAt).trimEnd()));
		remaining = remaining.slice(splitAt).trimStart();
	}
	if (remaining) {
		chunks.push(remaining);
	}
	return chunks;
}

function balanceCodeFence(value: string) {
	const fenceCount = value.match(/^```/gm)?.length ?? 0;
	return fenceCount % 2 === 0 ? value : `${value}\n\`\`\``;
}

export function truncateGraphemes(value: string, maximum: number) {
	const graphemes = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)].map((segment) => segment.segment);
	return graphemes.length <= maximum ? value : `${graphemes.slice(0, maximum - 1).join("")}…`;
}

function stripRelayMarkers(value: string) {
	return value.replaceAll(/<!--\s*forum-relay:[\s\S]*?-->/gi, "");
}
