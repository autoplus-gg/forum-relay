import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeConfig } from "@/config/normalize.js";
import { normalizeGitHubWebhook, verifyGitHubSignature } from "@/github/webhook.js";
import config from "../../config/config.example.js";

const normalizedConfig = normalizeConfig(config);

describe("GitHub webhook intake", () => {
	it("verifies the exact raw bytes", () => {
		const body = new TextEncoder().encode('{"action":"opened"}');
		const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;

		expect(verifyGitHubSignature(body, signature, "secret")).toBe(true);
		expect(verifyGitHubSignature(new TextEncoder().encode('{"action": "opened"}'), signature, "secret")).toBe(false);
		expect(verifyGitHubSignature(body, "sha1=bad", "secret")).toBe(false);
	});

	it("normalizes a configured issue into an ordered durable event", () => {
		const result = normalizeGitHubWebhook(
			normalizedConfig,
			"12345678-1234-1234-1234-123456789abc",
			"issues",
			JSON.stringify({
				action: "opened",
				issue: { id: 50, number: 12 },
				repository: { id: 10, full_name: "example/feedback" }
			})
		);

		expect(result).toMatchObject({
			mappingKey: "feedback",
			event: {
				eventKind: "issues.opened",
				idempotencyKey: "github:12345678-1234-1234-1234-123456789abc",
				mappingKey: "feedback",
				partitionKey: "github:10:issue:12",
				platform: "github"
			}
		});
	});

	it("accepts issue-backed Project item events before resolving their mapping from the database", () => {
		const result = normalizeGitHubWebhook(
			normalizedConfig,
			"12345678-1234-1234-1234-123456789abc",
			"projects_v2_item",
			JSON.stringify({
				action: "edited",
				projects_v2_item: {
					content_node_id: "I_kwDOExample",
					content_type: "Issue"
				},
				sender: { id: 1, login: "example-user" }
			})
		);

		expect(result.reason).toBeUndefined();
		expect(result.mappingKey).toBeUndefined();
		expect(result.event.partitionKey).toBe("github:issue-node:I_kwDOExample");
		expect(result.event.eventKind).toBe("projects_v2_item.edited");
	});

	it("ignores pull requests and unconfigured repositories", () => {
		expect(
			normalizeGitHubWebhook(
				normalizedConfig,
				"12345678-1234-1234-1234-123456789abc",
				"issues",
				JSON.stringify({
					action: "opened",
					issue: { number: 1, pull_request: { url: "https://api.github.com/pulls/1" } },
					repository: { id: 10, full_name: "example/feedback" }
				})
			).reason
		).toBe("pull-request");

		expect(
			normalizeGitHubWebhook(
				normalizedConfig,
				"abcdefab-1234-1234-1234-123456789abc",
				"issues",
				JSON.stringify({
					action: "opened",
					issue: { number: 1 },
					repository: { id: 10, full_name: "somewhere/else" }
				})
			).reason
		).toBe("unconfigured-repository");
	});
});
