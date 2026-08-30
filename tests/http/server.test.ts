import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeConfig } from "@/config/normalize.js";
import type { RuntimeEnvironment } from "@/core/environment.js";
import { createLogger } from "@/core/logger.js";
import type { EnqueueInbox } from "@/db/job-repository.js";
import { RelayHttpServer } from "@/http/server.js";
import config from "../../config/config.example.js";

const normalizedConfig = normalizeConfig(config);
const environment: RuntimeEnvironment = {
	databaseUrl: "file:test.db",
	discordToken: "discord-token",
	githubAppId: "1",
	githubPrivateKey: "private-key",
	githubWebhookSecret: "webhook-secret",
	host: "127.0.0.1",
	logLevel: "info",
	port: 3000
};

describe("HTTP GitHub webhook endpoint", () => {
	it("authenticates and enqueues issue lifecycle events", async () => {
		const events: EnqueueInbox[] = [];
		const logs: string[] = [];
		const server = new RelayHttpServer({
			config: normalizedConfig,
			environment,
			jobs: {
				enqueueInbox: async (event) => {
					events.push(event);
					return true;
				}
			},
			logger: createLogger("test", { write: (line) => logs.push(line) }),
			readiness: { database: true, discord: true, github: true, lease: true }
		});
		const body = JSON.stringify({
			action: "closed",
			issue: { id: 50, number: 12 },
			repository: { id: 10, full_name: "example/feedback" }
		});

		const response = await server.handle(signedRequest(body));

		expect(response.status).toBe(202);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			eventKind: "issues.closed",
			mappingKey: "feedback",
			partitionKey: "github:10:issue:12"
		});
		expect(logs.some((line) => line.includes('"message":"Accepted GitHub webhook."'))).toBe(true);
		expect(logs.some((line) => line.includes('"eventKind":"issues.closed"'))).toBe(true);
	});

	it("logs unknown POST routes so a misconfigured GitHub App URL is visible", async () => {
		const logs: string[] = [];
		const server = new RelayHttpServer({
			config: normalizedConfig,
			environment,
			jobs: { enqueueInbox: async () => true },
			logger: createLogger("test", { write: (line) => logs.push(line) }),
			readiness: { database: true, discord: true, github: true, lease: true }
		});

		const response = await server.handle(new Request("http://relay.example.com/github", { method: "POST" }));

		expect(response.status).toBe(404);
		expect(logs.some((line) => line.includes('"path":"/github"'))).toBe(true);
	});
});

function signedRequest(body: string) {
	const signature = createHmac("sha256", environment.githubWebhookSecret).update(body).digest("hex");
	return new Request("http://relay.example.com/webhooks/github", {
		body,
		headers: {
			"content-type": "application/json",
			"x-github-delivery": "12345678-1234-1234-1234-123456789abc",
			"x-github-event": "issues",
			"x-hub-signature-256": `sha256=${signature}`
		},
		method: "POST"
	});
}
