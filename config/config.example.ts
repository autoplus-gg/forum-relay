import { defineConfig } from "@/config/index.js";

export default defineConfig("0.0.1", {
	// Discord application and private deployment owner.
	clientId: "123456789012345678",
	guildId: "123456789012345678",
	ownerId: "123456789012345678",
	administratorRoleIds: ["123456789012345678"],
	logChannelId: "123456789012345678",

	// Public HTTP or HTTPS origin that GitHub uses to deliver App webhooks.
	publicBaseUrl: "http://relay.example.com:3000",

	maintenance: {
		failedWebhookDeliveryCheckMinutes: 5,
		fullReconciliationIntervalHours: 24,
		localBackupCount: 7,
		processedPayloadRetentionDays: 30
	},

	status: {
		enabled: true,
		text: "Syncing Discord forums with GitHub Issues",
		type: "WATCHING",
		status: "online"
	},

	// One deployment may contain several independent one-to-one mappings.
	mappings: {
		feedback: {
			forumChannelId: "123456789012345678",
			repository: {
				owner: "example",
				name: "feedback"
			},
			moderatorRoleIds: ["123456789012345678"],

			bootstrap: {
				source: "github",
				issueFilter: "open-only"
			}
		}
	}
});
