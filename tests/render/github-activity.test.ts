import { describe, expect, it } from "vitest";
import { renderGitHubActivity } from "@/render/github-activity.js";

const sender = {
	avatar_url: "https://avatars.githubusercontent.com/u/1",
	id: 1,
	login: "example-user"
};

describe("GitHub activity rendering", () => {
	it("links actors and labels without creating mentions", () => {
		const rendered = renderGitHubActivity("issues.labeled", {
			action: "labeled",
			label: { name: "discord bot" },
			sender
		});

		expect(rendered?.content).toBe("> [example-user](https://github.com/example-user) added the `discord bot` label on GitHub");
	});

	it("renders a Project status transition", () => {
		const rendered = renderGitHubActivity(
			"projects_v2_item.edited",
			{
				action: "edited",
				changes: {
					field_value: {
						field_name: "Status",
						from: { id: "todo", name: "Todo" },
						to: { id: "progress", name: "In progress" }
					}
				},
				sender
			},
			{ title: "Public Issue Tracker", url: "https://github.com/orgs/example-org/projects/1" }
		);

		expect(rendered?.content).toBe(
			"> [example-user](https://github.com/example-user) moved this from `Todo` to `In progress` in [Public Issue Tracker](https://github.com/orgs/example-org/projects/1) on GitHub"
		);
	});

	it("does not expose Markdown escapes in GitHub bot names", () => {
		const rendered = renderGitHubActivity(
			"projects_v2_item.edited",
			{
				action: "edited",
				changes: { field_value: { field_name: "Status", to: { name: "Todo" } } },
				sender: {
					avatar_url: "https://avatars.githubusercontent.com/in/54585",
					html_url: "https://github.com/apps/github-project-automation",
					id: 2,
					login: "github-project-automation[bot]"
				}
			},
			{ title: "Public Issue Tracker", url: "https://github.com/orgs/example-org/projects/1" }
		);

		expect(rendered?.content).toContain("[github-project-automation[bot]]");
		expect(rendered?.content).not.toContain("\\-");
		expect(rendered?.content).not.toContain("\\[");
	});

	it("renders title changes while ignoring ordinary body edits", () => {
		const title = renderGitHubActivity("issues.edited", {
			action: "edited",
			changes: { title: { from: "Old title" } },
			issue: { title: "New title" },
			sender
		});
		const body = renderGitHubActivity("issues.edited", {
			action: "edited",
			changes: { body: { from: "Old body" } },
			issue: { title: "Same title" },
			sender
		});

		expect(title?.content).toContain("~~Old title~~");
		expect(title?.content).toContain("**New title**");
		expect(body).toBeUndefined();
	});
});
