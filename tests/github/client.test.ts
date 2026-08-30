import { generateKeyPairSync } from "node:crypto";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "@/config/normalize.js";
import type { RuntimeEnvironment } from "@/core/environment.js";
import { createLogger } from "@/core/logger.js";
import { GitHubClient, normalizeGitHubId } from "@/github/client.js";
import config from "../../config/config.example.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
	format: "pem",
	type: "pkcs8"
});

const environment: RuntimeEnvironment = {
	databaseUrl: "file:test.db",
	discordToken: "test-discord-token",
	githubAppId: "1",
	githubPrivateKey: privateKey.toString(),
	githubWebhookSecret: "test-webhook-secret",
	host: "127.0.0.1",
	logLevel: "error",
	port: 3000
};

const unusedDatabase: Pick<Client, "batch" | "execute"> = {
	batch: () => {
		throw new Error("The webhook recovery path must not access the relay database.");
	},
	execute: () => {
		throw new Error("The webhook recovery path must not access the relay database.");
	}
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GitHub client", () => {
	it("normalizes API bigint IDs without allowing precision loss", () => {
		expect(normalizeGitHubId(42n)).toBe(42);
		expect(() => normalizeGitHubId(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow("unsupported numeric ID");
	});

	it("reports webhook URL, content type, and subscription mismatches", async () => {
		const logs: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			const data =
				url.pathname === "/app/hook/config"
					? { content_type: "form", insecure_ssl: "0", url: "http://relay.example.com:3000/wrong" }
					: {
							events: ["issue_comment", "label", "repository"],
							permissions: {
								contents: "read",
								issues: "write",
								metadata: "read",
								organization_projects: "read"
							},
							slug: "example-forum-relay"
						};
			return Response.json(data);
		});
		vi.stubGlobal("fetch", fetchMock);

		const client = new GitHubClient(
			environment,
			normalizeConfig(config),
			unusedDatabase,
			createLogger("test", { level: "warn", write: (line) => logs.push(line) })
		);

		await expect(client.inspectWebhookConfiguration()).resolves.toEqual({
			configuredUrl: "http://relay.example.com:3000/wrong",
			contentType: "form",
			expectedUrl: "http://relay.example.com:3000/webhooks/github",
			missingEvents: ["issue_dependencies", "issues", "sub_issues", "projects_v2_item"],
			missingPermissions: []
		});
		expect(client.isOwnBotLogin("example-forum-relay[bot]")).toBe(true);
		expect(logs.some((line) => line.includes('"message":"GitHub App configuration does not match Forum Relay."'))).toBe(true);
	});

	it("follows cursor pagination when recovering failed App webhook deliveries", async () => {
		const requestedUrls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = input instanceof Request ? input.url : input.toString();
			requestedUrls.push(url);

			if (url.includes("/attempts")) {
				return new Response(null, { status: 202 });
			}

			const isSecondPage = url.includes("cursor=next-delivery");
			return new Response(JSON.stringify(isSecondPage ? [{ id: 2, status_code: 502 }] : [{ id: 1, status_code: 500 }]), {
				headers: isSecondPage
					? { "content-type": "application/json" }
					: {
							"content-type": "application/json",
							link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next-delivery>; rel="next"'
						},
				status: 200
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const client = new GitHubClient(
			environment,
			normalizeConfig(config),
			unusedDatabase,
			createLogger("test", { level: "error", write: () => undefined })
		);

		await expect(client.redeliverFailedWebhooks()).resolves.toBe(2);
		const deliveryRequests = requestedUrls.filter((url) => url.includes("/app/hook/deliveries?")).map((url) => new URL(url));
		expect(deliveryRequests).toHaveLength(2);
		expect(deliveryRequests[0]?.searchParams.get("per_page")).toBe("100");
		expect(deliveryRequests[0]?.searchParams.has("cursor")).toBe(false);
		expect(deliveryRequests[1]?.searchParams.get("per_page")).toBe("100");
		expect(deliveryRequests[1]?.searchParams.get("cursor")).toBe("next-delivery");
		expect(requestedUrls.some((url) => /[?&]page=/.test(url))).toBe(false);
	});

	it("does not amplify failed webhook redeliveries", async () => {
		let attempts = 0;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("/attempts")) {
				attempts += 1;
				return new Response(null, { status: 202 });
			}
			return Response.json([
				{ id: 1, redelivery: false, status_code: 500 },
				{ id: 2, redelivery: true, status_code: 500 }
			]);
		});
		vi.stubGlobal("fetch", fetchMock);
		const client = new GitHubClient(
			environment,
			normalizeConfig(config),
			unusedDatabase,
			createLogger("test", { level: "error", write: () => undefined })
		);

		await expect(client.redeliverFailedWebhooks(1_000)).resolves.toBe(1);
		await expect(client.redeliverFailedWebhooks(1_001)).resolves.toBe(0);
		expect(attempts).toBe(1);
	});
});
