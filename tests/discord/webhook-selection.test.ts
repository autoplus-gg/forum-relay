import { describe, expect, it } from "vitest";
import { forumRelayWebhookName, isReusableForumRelayWebhook, isStoredForumRelayWebhook } from "@/discord/webhook-selection.js";

const candidate = {
	application_id: "100",
	channel_id: "200",
	name: "Forum Relay · feedback",
	token: "secret"
};

describe("Discord webhook reuse", () => {
	it("adopts a matching application webhook after a database reset", () => {
		expect(isReusableForumRelayWebhook(candidate, "100", "200", "feedback")).toBe(true);
		expect(isStoredForumRelayWebhook(candidate, "100", "200")).toBe(true);
	});

	it("also recognizes bot-created and legacy-named Forum Relay webhooks", () => {
		expect(
			isReusableForumRelayWebhook(
				{
					application_id: null,
					channel_id: "200",
					name: "Forum Relay Â· feedback",
					token: "secret",
					user: { id: "100" }
				},
				"100",
				"200",
				"feedback"
			)
		).toBe(true);
	});

	it("rejects unrelated, tokenless, and cross-channel webhooks", () => {
		expect(isReusableForumRelayWebhook({ ...candidate, name: "Other bot" }, "100", "200", "feedback")).toBe(false);
		expect(isReusableForumRelayWebhook({ ...candidate, token: undefined }, "100", "200", "feedback")).toBe(false);
		expect(isReusableForumRelayWebhook({ ...candidate, channel_id: "different" }, "100", "200", "feedback")).toBe(false);
	});

	it("uses the correctly encoded webhook name for new webhooks", () => {
		expect(forumRelayWebhookName("feedback")).toBe("Forum Relay · feedback");
	});
});
