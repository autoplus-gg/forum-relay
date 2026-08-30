import { describe, expect, it, vi } from "vitest";
import { isForbiddenAddress, isRecognizedGitHubMediaUrl, mediaFetchFailure } from "@/media/safe-download.js";
import { DiscordMediaProxy } from "@/media/ticketpm.js";

describe("media boundaries", () => {
	it("accepts only recognized GitHub HTTPS media hosts", () => {
		expect(isRecognizedGitHubMediaUrl("https://user-images.githubusercontent.com/a.png")).toBe(true);
		expect(isRecognizedGitHubMediaUrl("https://raw.githubusercontent.com/a/b/main/file.png")).toBe(true);
		expect(isRecognizedGitHubMediaUrl("https://github-production-user-asset-6210df.s3.amazonaws.com/1/screenshot.png")).toBe(
			true
		);
		expect(isRecognizedGitHubMediaUrl("http://raw.githubusercontent.com/a/b/main/file.png")).toBe(false);
		expect(isRecognizedGitHubMediaUrl("https://example.com/file.png")).toBe(false);
	});

	it("rejects local, private, metadata, multicast, and mapped addresses", () => {
		for (const address of [
			"127.0.0.1",
			"10.0.0.1",
			"172.16.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"224.0.0.1",
			"::1",
			"fd00::1",
			"fe80::1",
			"::ffff:127.0.0.1"
		]) {
			expect(isForbiddenAddress(address), address).toBe(true);
		}
		expect(isForbiddenAddress("1.1.1.1")).toBe(false);
		expect(isForbiddenAddress("2606:4700:4700::1111")).toBe(false);
	});

	it("does not retry an attachment that GitHub reports as missing", () => {
		const failure = mediaFetchFailure(404);
		expect(failure.category).toBe("not-found");
		expect(failure.code).toBe("MEDIA_NOT_FOUND");
	});

	it("uses the authenticated ticket.pm v2 client and returns the durable hash", async () => {
		const fetchImplementation = Object.assign(
			vi.fn(async (_request: URL | RequestInfo, init?: RequestInit) => {
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer media-token");
				return Response.json({ hash: "immutable-hash" });
			}),
			{ preconnect: vi.fn() }
		);
		const proxy = new DiscordMediaProxy("media-token", fetchImplementation);

		await expect(proxy.uploadAttachment("https://cdn.discordapp.com/file.png")).resolves.toEqual({
			hash: "immutable-hash",
			url: "https://m.ticket.pm/v2/attachments/immutable-hash"
		});
	});

	it("uses the ticket.pm v2 client without an authorization header when no token is configured", async () => {
		const fetchImplementation = Object.assign(
			vi.fn(async (_request: URL | RequestInfo, init?: RequestInit) => {
				expect(new Headers(init?.headers).has("authorization")).toBe(false);
				return Response.json({ hash: "anonymous-hash" });
			}),
			{ preconnect: vi.fn() }
		);
		const proxy = new DiscordMediaProxy(undefined, fetchImplementation);

		await expect(proxy.uploadAttachment("https://cdn.discordapp.com/file.png")).resolves.toEqual({
			hash: "anonymous-hash",
			url: "https://m.ticket.pm/v2/attachments/anonymous-hash"
		});
	});
});
