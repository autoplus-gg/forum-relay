import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeConfig } from "@/config/normalize.js";
import { createLogger } from "@/core/logger.js";
import { createConsistentBackup, createPreMigrationBackup } from "@/db/backups.js";
import type { DatabaseContext } from "@/db/client.js";
import { createDatabase } from "@/db/client.js";
import { MappingIdentityChangedError, MappingRepository } from "@/db/mapping-repository.js";
import config from "../../config/config.example.js";

let database: DatabaseContext | undefined;
afterEach(() => database?.close());

function environment(databaseUrl: string) {
	return {
		databaseUrl,
		discordToken: "test-discord-token",
		githubAppId: "1",
		githubPrivateKey: "test-private-key",
		githubWebhookSecret: "test-webhook-secret",
		host: "127.0.0.1",
		logLevel: "error" as const,
		port: 3000,
		ticketPmToken: "test-ticketpm-token"
	};
}

const logger = createLogger("test", { level: "error", write: () => undefined });

describe("database persistence", () => {
	it("rejects mapping identity reuse without partially applying config", async () => {
		const directory = join(process.cwd(), ".data", "tests", crypto.randomUUID());
		mkdirSync(directory, { recursive: true });
		database = await createDatabase(environment(`file:${join(directory, "test.db")}`), logger);
		const repository = new MappingRepository(database.client);
		const normalized = normalizeConfig(config);
		await repository.applyConfig(normalized);
		normalized.mappings.feedback.repository.name = "different";

		await expect(repository.applyConfig(normalized)).rejects.toBeInstanceOf(MappingIdentityChangedError);
		const stored = await database.client.execute("SELECT github_repository FROM mappings WHERE key = 'feedback'");
		expect(stored.rows[0]?.github_repository).toBe("feedback");
	});

	it("creates verified consistent and pre-migration SQLite backups", async () => {
		const directory = join(process.cwd(), ".data", "tests", crypto.randomUUID());
		mkdirSync(directory, { recursive: true });
		const databasePath = join(directory, "test.db");
		const databaseUrl = `file:${databasePath}`;
		database = await createDatabase(environment(databaseUrl), logger);
		await database.client.execute("INSERT INTO app_meta (key, value, updated_at) VALUES ('test', 'value', 1)");

		const consistent = await createConsistentBackup({
			client: database.client,
			databaseUrl,
			logger,
			retainCount: 7
		});
		expect(consistent && existsSync(consistent.path)).toBe(true);
		database.close();
		database = undefined;

		const preMigration = createPreMigrationBackup(databaseUrl, logger);
		expect(preMigration && existsSync(preMigration.path)).toBe(true);
	});
});
