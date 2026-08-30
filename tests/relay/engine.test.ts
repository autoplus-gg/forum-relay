import { describe, expect, it } from "vitest";
import {
	discordSyncFingerprint,
	formatGitHubCloseReason,
	parseDiscordMessage,
	reconciliationLifecycleRepairs,
	shouldIgnoreUnlinkedGitHubIssue,
	shouldSuppressGitHubBodyEcho
} from "@/relay/engine.js";

describe("relay Discord message boundary", () => {
	it("parses Discord's raw REST payload", () => {
		expect(
			parseDiscordMessage({
				attachments: [],
				author: { id: "100", username: "example-user" },
				channel_id: "200",
				content: "A suggestion",
				id: "300",
				timestamp: "2026-07-30T13:00:00.000Z"
			})
		).toMatchObject({
			channelId: "200",
			content: "A suggestion",
			revision: "2026-07-30T13:00:00.000Z"
		});
	});

	it("recovers thread-create jobs persisted with the former normalized shape", () => {
		expect(
			parseDiscordMessage({
				attachments: [
					{
						contentType: "image/png",
						filename: "example.png",
						id: "400",
						size: 100,
						url: "https://cdn.discordapp.com/example.png"
					}
				],
				author: {
					avatarUrl: "https://cdn.discordapp.com/avatar.png",
					displayName: "Example User",
					id: "100",
					username: "example-user"
				},
				channelId: "200",
				content: "A suggestion",
				id: "300",
				revision: "2026-07-30T13:00:00.000Z"
			})
		).toMatchObject({
			attachments: [{ contentType: "image/png" }],
			author: {
				avatarUrl: "https://cdn.discordapp.com/avatar.png",
				displayName: "Example User"
			},
			channelId: "200",
			revision: "2026-07-30T13:00:00.000Z"
		});
	});
});

describe("GitHub echo suppression", () => {
	it("suppresses a Discord-origin issue returning through GitHub", () => {
		expect(shouldSuppressGitHubBodyEcho(true, true, "issues.opened", true, true)).toBe(true);
		expect(shouldSuppressGitHubBodyEcho(true, true, "issues.edited", true, true)).toBe(true);
	});

	it("suppresses an unchanged Discord-origin body during reconciliation", () => {
		expect(shouldSuppressGitHubBodyEcho(true, true, "issues.edited", false, false)).toBe(true);
	});

	it("preserves later human GitHub edits and reconciliation repairs", () => {
		expect(shouldSuppressGitHubBodyEcho(true, false, "issues.edited", true, false)).toBe(false);
		expect(shouldSuppressGitHubBodyEcho(true, false, "issues.edited", false, true)).toBe(false);
		expect(shouldSuppressGitHubBodyEcho(false, true, "issues.opened", true, true)).toBe(false);
	});
});

describe("Discord render revisions", () => {
	const render = {
		body: "Unchanged body",
		jumpUrl: "https://github.com/example-org/forum-relay/issues/1",
		labels: ["bug"],
		repository: "https://github.com/example-org/forum-relay",
		title: "Original title"
	};

	it("changes for title-only and label-only issue edits", () => {
		expect(discordSyncFingerprint(render)).not.toBe(discordSyncFingerprint({ ...render, title: "Renamed issue" }));
		expect(discordSyncFingerprint(render)).not.toBe(discordSyncFingerprint({ ...render, labels: ["enhancement"] }));
	});

	it("is stable for an identical reconciliation snapshot", () => {
		expect(discordSyncFingerprint(render)).toBe(discordSyncFingerprint({ ...render, labels: [...render.labels] }));
	});
});

describe("lifecycle reconciliation", () => {
	it("repairs Discord drift even when the database already has GitHub's state", () => {
		expect(reconciliationLifecycleRepairs("closed", false, "closed", false, { archived: false, locked: false })).toEqual([
			"closed"
		]);
		expect(reconciliationLifecycleRepairs("open", false, "open", false, { archived: true, locked: false })).toEqual(["reopened"]);
	});

	it("does not replay lifecycle notices when Discord already converged", () => {
		expect(reconciliationLifecycleRepairs("closed", false, "closed", false, { archived: true, locked: false })).toEqual([]);
		expect(reconciliationLifecycleRepairs("open", false, "open", false, { archived: false, locked: false })).toEqual([]);
	});

	it("repairs lock state independently and preserves an open locked issue", () => {
		expect(reconciliationLifecycleRepairs("open", true, "open", true, { archived: true, locked: false })).toEqual(["locked"]);
		expect(reconciliationLifecycleRepairs("open", true, "closed", true, { archived: true, locked: true })).toEqual(["reopened"]);
	});
});

describe("open-only GitHub intake", () => {
	const bootstrap = {
		issueFilter: "open-only",
		source: "github"
	} as const;

	it("ignores a closed issue that has no imported thread", () => {
		expect(shouldIgnoreUnlinkedGitHubIssue(false, "closed", bootstrap)).toBe(true);
	});

	it("still processes closures when the Discord thread exists", () => {
		expect(shouldIgnoreUnlinkedGitHubIssue(true, "closed", bootstrap)).toBe(false);
	});

	it("still imports unlinked open issues", () => {
		expect(shouldIgnoreUnlinkedGitHubIssue(false, "open", bootstrap)).toBe(false);
	});

	it("ignores a historical open webhook when GitHub currently reports the issue closed", () => {
		expect(shouldIgnoreUnlinkedGitHubIssue(false, "open", bootstrap, "closed")).toBe(true);
	});
});

describe("GitHub close reasons", () => {
	it("renders a duplicate with GitHub and mapped Discord targets", () => {
		expect(
			formatGitHubCloseReason(
				"duplicate",
				"https://github.com/example-org/forum-relay/issues/2",
				"https://discord.com/channels/1/2"
			)
		).toBe(
			"marked as duplicate of [#2](https://github.com/example-org/forum-relay/issues/2) ([Discord thread](https://discord.com/channels/1/2))"
		);
	});

	it("does not fall back to completed when the duplicate target is unavailable", () => {
		expect(formatGitHubCloseReason("duplicate")).toBe("marked as duplicate");
	});
});
