import { ComponentType, MessageFlags } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { webhookMessageBody } from "@/discord/components.js";

describe("Discord webhook message body", () => {
	it("passes downloaded files with Components V2 messages", () => {
		const file = { contentType: "image/png", data: Uint8Array.of(1), name: "screenshot.png" };
		const body = webhookMessageBody({
			components: [{ type: ComponentType.MediaGallery, items: [{ media: { url: "attachment://screenshot.png" } }] }],
			files: [file],
			username: "octocat"
		});

		expect(body.files).toEqual([file]);
		expect(body.flags).toBe(MessageFlags.IsComponentsV2);
	});
});
