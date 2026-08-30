import { describe, expect, it } from "vitest";
import { defineConfig } from "@/config/index.js";
import { normalizeConfig } from "@/config/normalize.js";

function validConfig() {
	return defineConfig("0.0.1", {
		administratorRoleIds: ["123456789012345679"],
		clientId: "123456789012345678",
		guildId: "123456789012345680",
		mappings: {
			feedback: {
				bootstrap: { source: "github", issueFilter: "open-only" },
				forumChannelId: "123456789012345681",
				moderatorRoleIds: [],
				repository: { name: "feedback", owner: "example-org" }
			}
		},
		ownerId: "123456789012345682",
		publicBaseUrl: "https://relay.example.com"
	});
}

describe("normalizeConfig", () => {
	it("adds maintenance defaults without mutating the source", () => {
		const source = validConfig();
		const normalized = normalizeConfig(source);

		expect(normalized.maintenance).toEqual({
			failedWebhookDeliveryCheckMinutes: 5,
			fullReconciliationIntervalHours: 24,
			localBackupCount: 7,
			processedPayloadRetentionDays: 30
		});
		expect(source.maintenance).toBeUndefined();
	});

	it("rejects duplicate destinations", () => {
		const duplicate = validConfig();
		duplicate.mappings.second = {
			...duplicate.mappings.feedback,
			repository: { name: "other", owner: "example-org" }
		};
		expect(() => normalizeConfig(duplicate)).toThrow(/more than one mapping/);
	});

	it("accepts public HTTP origins and rejects non-HTTP protocols", () => {
		const local = validConfig();
		local.publicBaseUrl = "http://localhost:3000";
		expect(() => normalizeConfig(local)).not.toThrow();

		const publicHttp = validConfig();
		publicHttp.publicBaseUrl = "http://relay.example.com";
		expect(() => normalizeConfig(publicHttp)).not.toThrow();

		const fileUrl = validConfig();
		fileUrl.publicBaseUrl = "file:///tmp/forum-relay";
		expect(() => normalizeConfig(fileUrl)).toThrow(/HTTP or HTTPS/);
	});
});
