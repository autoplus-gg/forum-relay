import { describe, expect, it } from "vitest";
import { discordEventIdempotencyKey } from "@/discord/event-idempotency.js";
import { shouldIgnoreDiscordMessage, shouldIgnoreStoredDiscordMessage } from "@/discord/message-origin.js";

const clientId = "123456789012345678";

describe("Discord message intake origin filtering", () => {
	it("accepts human-authored messages", () => {
		expect(
			shouldIgnoreDiscordMessage(
				{
					author: {
						bot: false,
						id: "223456789012345678"
					}
				},
				clientId
			)
		).toBe(false);
	});

	it("rejects every webhook, bot, application-owned, and interaction message", () => {
		expect(shouldIgnoreDiscordMessage({ webhook_id: "323456789012345678" }, clientId)).toBe(true);
		expect(shouldIgnoreDiscordMessage({ author: { bot: true, id: "423456789012345678" } }, clientId)).toBe(true);
		expect(shouldIgnoreDiscordMessage({ author: { id: clientId } }, clientId)).toBe(true);
		expect(shouldIgnoreDiscordMessage({ application_id: clientId }, clientId)).toBe(true);
		expect(shouldIgnoreDiscordMessage({ interaction_metadata: {} }, clientId)).toBe(true);
	});

	it("rejects a relay webhook event that was already persisted", () => {
		expect(
			shouldIgnoreStoredDiscordMessage(
				{
					author: {
						bot: false,
						id: "223456789012345678"
					},
					webhook_id: "323456789012345678"
				},
				clientId
			)
		).toBe(true);
	});
});

describe("Discord event idempotency", () => {
	it("deduplicates identical immutable gateway deliveries", () => {
		const payload = { channel_id: "200", content: "first edit", edited_timestamp: "2026-07-30T18:00:00.000Z", id: "300" };
		expect(discordEventIdempotencyKey("message.create", "300", payload)).toBe(
			discordEventIdempotencyKey("message.create", "300", payload)
		);
	});

	it("accepts every mutable gateway dispatch, including a state that recurs", () => {
		const message = { content: "same payload" };
		expect(discordEventIdempotencyKey("message.update", "300", message, "dispatch-1")).not.toBe(
			discordEventIdempotencyKey("message.update", "300", message, "dispatch-2")
		);
		expect(discordEventIdempotencyKey("thread.update", "200", { archived: true }, "first-close")).not.toBe(
			discordEventIdempotencyKey("thread.update", "200", { archived: true }, "second-close")
		);
	});
});
