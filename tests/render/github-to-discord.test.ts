import { ComponentType } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { renderGitHubToDiscord, truncateGraphemes } from "@/render/github-to-discord.js";

describe("renderGitHubToDiscord", () => {
	it("places Markdown and HTML images between text components", () => {
		const [segment] = renderGitHubToDiscord({
			authorUsername: "octocat",
			body: 'before\n\n![diagram](assets/diagram.png)\n\nmiddle\n\n<img src="https://github.com/a/b/raw/main/end.png" alt="end">\n\nafter',
			jumpUrl: "https://github.com/a/b/issues/1#issue-1",
			repositoryUrl: "https://github.com/a/b"
		});

		expect(segment?.components.map((component) => component.type)).toEqual([
			ComponentType.TextDisplay,
			ComponentType.MediaGallery,
			ComponentType.TextDisplay,
			ComponentType.MediaGallery,
			ComponentType.TextDisplay,
			ComponentType.Separator,
			ComponentType.TextDisplay
		]);
		const galleries = segment?.components.filter((component) => component.type === ComponentType.MediaGallery);
		expect(galleries?.[0]?.items[0]?.media.url).toBe("https://github.com/a/b/assets/diagram.png");
		expect(galleries?.[1]?.items[0]?.description).toBe("end");
	});

	it("strips relay markers and keeps the jump link on the final segment", () => {
		const segments = renderGitHubToDiscord({
			authorUsername: "octocat",
			body: `${"word ".repeat(40_000)}<!-- forum-relay:spoof -->`,
			jumpUrl: "https://github.com/a/b/issues/1",
			repositoryUrl: "https://github.com/a/b"
		});

		expect(segments.length).toBeGreaterThan(1);
		expect(JSON.stringify(segments)).not.toContain("spoof");
		expect(JSON.stringify(segments.at(-1))).toContain("Jump to GitHub");
	});

	it("keeps arbitrary external images as links instead of server-fetchable media", () => {
		const [segment] = renderGitHubToDiscord({
			authorUsername: "octocat",
			body: "before ![remote](https://example.com/image.png) after",
			jumpUrl: "https://github.com/a/b/issues/1",
			repositoryUrl: "https://github.com/a/b"
		});

		expect(segment?.components.some((component) => component.type === ComponentType.MediaGallery)).toBe(false);
		expect(JSON.stringify(segment)).toContain("Image: remote");
	});

	it("uses Discord webhook attachments for GitHub images", () => {
		const sourceUrl = "https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc";
		const attachment = { contentType: "image/png", data: Uint8Array.of(1), name: "screenshot.png" };
		const [segment] = renderGitHubToDiscord({
			authorUsername: "octocat",
			body: `![screenshot](${sourceUrl})`,
			jumpUrl: "https://github.com/a/b/issues/1",
			mediaAttachments: new Map([[sourceUrl, attachment]]),
			repositoryUrl: "https://github.com/a/b"
		});

		const gallery = segment?.components.find((component) => component.type === ComponentType.MediaGallery);
		expect(gallery?.items[0]?.media.url).toBe("attachment://screenshot.png");
		expect(segment?.files).toEqual([attachment]);
	});

	it("falls back to a link when a recognized GitHub image could not be downloaded", () => {
		const sourceUrl = "https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc";
		const [segment] = renderGitHubToDiscord({
			authorUsername: "octocat",
			body: `![screenshot](${sourceUrl})`,
			jumpUrl: "https://github.com/a/b/issues/1",
			mediaAttachments: new Map(),
			repositoryUrl: "https://github.com/a/b"
		});

		expect(segment?.components.some((component) => component.type === ComponentType.MediaGallery)).toBe(false);
		expect(JSON.stringify(segment)).toContain("Image: screenshot");
	});

	it("splits webhook attachments at Discord's ten-file message limit", () => {
		const sources = Array.from(
			{ length: 11 },
			(_, index) => `https://github.com/user-attachments/assets/12345678-1234-1234-1234-${String(index).padStart(12, "0")}`
		);
		const attachments = new Map(
			sources.map((source, index) => [source, { contentType: "image/png", data: Uint8Array.of(index), name: `${index}.png` }])
		);
		const segments = renderGitHubToDiscord({
			authorUsername: "octocat",
			body: sources.map((source, index) => `![${index}](${source})`).join("\n"),
			jumpUrl: "https://github.com/a/b/issues/1",
			mediaAttachments: attachments,
			repositoryUrl: "https://github.com/a/b"
		});

		expect(segments.map((segment) => segment.files.length)).toEqual([10, 1]);
	});

	it("truncates by Unicode grapheme rather than UTF-16 code unit", () => {
		expect(truncateGraphemes("👩‍💻👩‍💻👩‍💻", 3)).toBe("👩‍💻👩‍💻👩‍💻");
		expect(truncateGraphemes("👩‍💻👩‍💻👩‍💻", 2)).toBe("👩‍💻…");
	});
});
