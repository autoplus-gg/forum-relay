import { describe, expect, it } from "vitest";
import { renderDiscordToGitHub } from "@/render/discord-to-github.js";

describe("renderDiscordToGitHub", () => {
	it("adds fixed attribution, converts tokens, and prevents mention notifications", () => {
		const rendered = renderDiscordToGitHub({
			attachments: [
				{
					contentType: "image/png",
					filename: "screen.png",
					proxyUrl: "https://m.ticket.pm/v2/attachments/hash",
					size: 100,
					url: "https://cdn.discordapp.com/original"
				}
			],
			author: {
				avatarUrl: "https://cdn.discordapp.com/avatar.png",
				displayName: "Alice Example",
				id: "123456789012345678",
				username: "alice"
			},
			content: "hello <@123456789012345679> @everyone <#123456789012345680> <:wave:123456789012345681>",
			context: {
				channels: { "123456789012345680": "feedback" },
				guildId: "123456789012345682",
				roles: {},
				threadId: "123456789012345683",
				users: { "123456789012345679": "Bob" }
			},
			messageId: "123456789012345684"
		});

		expect(rendered).toContain('<img src="https://cdn.discordapp.com/avatar.png" width="24" height="24" alt="">');
		expect(rendered).not.toContain("![pfp]");
		expect(rendered).toContain(`@​Bob`);
		expect(rendered).toContain(`@​everyone`);
		expect(rendered).toContain("#feedback");
		expect(rendered).toContain(":wave:");
		expect(rendered).toContain("https://m.ticket.pm/v2/attachments/hash");
		expect(rendered).toContain("forum-relay:v1:discord-message:123456789012345684");
	});

	it("does not rewrite mention-like syntax inside code", () => {
		const rendered = renderDiscordToGitHub({
			attachments: [],
			author: { displayName: "Alice", id: "123456789012345678", username: "alice" },
			content: "`<@123456789012345679>` and <@123456789012345679>",
			context: {
				channels: {},
				guildId: "123456789012345680",
				roles: {},
				threadId: "123456789012345681",
				users: { "123456789012345679": "Bob" }
			},
			messageId: "123456789012345682"
		});

		expect(rendered).toContain("`<@123456789012345679>` and @​Bob");
	});
});
