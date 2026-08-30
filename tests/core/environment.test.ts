import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRuntimeEnvironment } from "@/core/environment.js";

function validEnvironment(): NodeJS.ProcessEnv {
	return {
		DB_FILE_NAME: "file:.data/test.db",
		DISCORD_TOKEN: "discord-token",
		GITHUB_APP_ID: "42",
		GITHUB_PRIVATE_KEY_BASE64: Buffer.from("private-key").toString("base64"),
		GITHUB_WEBHOOK_SECRET: "webhook-secret",
		TICKETPM_TOKEN: "ticketpm-token"
	};
}

describe("readRuntimeEnvironment", () => {
	it("loads direct values and defaults", () => {
		const environment = readRuntimeEnvironment(validEnvironment());

		expect(environment).toMatchObject({
			databaseUrl: "file:.data/test.db",
			githubPrivateKey: "private-key",
			host: "0.0.0.0",
			logLevel: "info",
			port: 3000
		});
	});

	it("does not require an m.ticket.pm token", () => {
		const source = validEnvironment();
		delete source.TICKETPM_TOKEN;

		expect(readRuntimeEnvironment(source).ticketPmToken).toBeUndefined();
	});

	it("loads secrets and the private key from files", () => {
		const directory = mkdtempSync(join(tmpdir(), "forum-relay-env-"));
		const secretPath = join(directory, "secret");
		const keyPath = join(directory, "key.pem");
		writeFileSync(secretPath, "discord-from-file\n");
		writeFileSync(keyPath, "private-key-from-file\n");
		const source = validEnvironment();
		delete source.DISCORD_TOKEN;
		delete source.GITHUB_PRIVATE_KEY_BASE64;
		source.DISCORD_TOKEN_FILE = secretPath;
		source.GITHUB_PRIVATE_KEY_PATH = keyPath;

		const environment = readRuntimeEnvironment(source);

		expect(environment.discordToken).toBe("discord-from-file");
		expect(environment.githubPrivateKey).toBe("private-key-from-file");
	});

	it("rejects ambiguous direct and file-backed secrets", () => {
		const source = validEnvironment();
		source.DISCORD_TOKEN_FILE = "secret.txt";

		expect(() => readRuntimeEnvironment(source)).toThrow(/Set only one/);
	});

	it("rejects example placeholders and invalid listener settings", () => {
		expect(() => readRuntimeEnvironment({ ...validEnvironment(), DISCORD_TOKEN: "replace-me" })).toThrow(/example placeholder/);
		expect(() => readRuntimeEnvironment({ ...validEnvironment(), PORT: "70000" })).toThrow(/PORT/);
		expect(() => readRuntimeEnvironment({ ...validEnvironment(), LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
	});
});
