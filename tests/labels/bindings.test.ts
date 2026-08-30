import { describe, expect, it } from "vitest";
import { planDiscordForumTags, planLabelBindings } from "@/labels/bindings.js";

describe("automatic label bindings", () => {
	it("maps unconfigured GitHub labels by name", () => {
		const bindings = planLabelBindings(
			[
				{ id: 2, name: "enhancement" },
				{ id: 1, name: "bug" }
			],
			[]
		);

		expect(bindings).toMatchObject([
			{ configuredDiscordName: "bug", configuredGithubName: "bug", githubLabelId: 1, position: 0 },
			{ configuredDiscordName: "enhancement", configuredGithubName: "enhancement", githubLabelId: 2, position: 1 }
		]);
	});

	it("shortens long names deterministically without configuration", () => {
		const bindings = planLabelBindings([{ id: 2, name: "a GitHub label longer than twenty characters" }], []);

		expect(bindings[0]).toMatchObject({
			configuredDiscordName: "a GitHub label lon~2",
			githubLabelId: 2,
			position: 0
		});
		expect(Array.from(bindings[0]?.configuredDiscordName ?? "")).toHaveLength(20);
	});

	it("preserves Discord identities and marks deleted GitHub labels stale", () => {
		const bindings = planLabelBindings(
			[{ id: 1, name: "renamed" }],
			[
				{
					configuredDiscordName: "old",
					configuredGithubName: "old",
					discordCurrentName: "old",
					discordTagId: "100",
					githubLabelId: 1
				},
				{
					configuredDiscordName: "deleted",
					configuredGithubName: "deleted",
					discordCurrentName: "deleted",
					discordTagId: "200",
					githubLabelId: 2
				}
			]
		);

		expect(bindings[0]).toMatchObject({
			configuredDiscordName: "renamed",
			discordTagId: "100",
			state: "RESOLVED"
		});
		expect(bindings[1]).toMatchObject({ discordTagId: "200", state: "STALE_GITHUB" });
	});
});

describe("Discord forum tag bindings", () => {
	it("preserves a manually renamed Discord tag once its ID is bound", () => {
		const plan = planDiscordForumTags(
			[{ emoji_id: null, emoji_name: null, id: "100", moderated: false, name: "Custom Discord name" }],
			[{ desiredName: "renamed-github-label", position: 0, storedTagId: "100" }],
			new Set()
		);

		expect(plan.changed).toBe(false);
		expect(plan.tags[0]?.name).toBe("Custom Discord name");
		expect(plan.resolutions).toEqual([{ position: 0, submittedIndex: 0, tagId: "100" }]);
	});

	it("uses names only to adopt an unbound tag or create a missing one", () => {
		const plan = planDiscordForumTags(
			[{ emoji_id: null, emoji_name: null, id: "100", moderated: false, name: "bug" }],
			[
				{ desiredName: "bug", position: 0 },
				{ desiredName: "feature", position: 1, storedTagId: "deleted" }
			],
			new Set()
		);

		expect(plan.changed).toBe(true);
		expect(plan.tags.map((tag) => tag.name)).toEqual(["bug", "feature"]);
		expect(plan.resolutions).toEqual([
			{ position: 0, submittedIndex: 0, tagId: "100" },
			{ position: 1, submittedIndex: 1, tagId: undefined }
		]);
	});

	it("removes only tags whose GitHub labels were deleted", () => {
		const plan = planDiscordForumTags(
			[
				{ emoji_id: null, emoji_name: null, id: "active", moderated: false, name: "Custom active name" },
				{ emoji_id: null, emoji_name: null, id: "stale", moderated: false, name: "Deleted label" },
				{ emoji_id: null, emoji_name: null, id: "discord-only", moderated: false, name: "Discord only" }
			],
			[{ desiredName: "github-name", position: 0, storedTagId: "active" }],
			new Set(["stale"])
		);

		expect(plan.changed).toBe(true);
		expect(plan.tags.map((tag) => tag.id)).toEqual(["active", "discord-only"]);
	});
});
