import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@/core/logger.js";
import type { DatabaseContext } from "@/db/client.js";
import { createDatabase } from "@/db/client.js";

export async function createTestDatabase(): Promise<DatabaseContext> {
	const directory = join(process.cwd(), ".data", "tests", crypto.randomUUID());
	mkdirSync(directory, { recursive: true });
	return createDatabase(
		{
			databaseUrl: `file:${join(directory, "test.db")}`,
			discordToken: "test-discord-token",
			githubAppId: "1",
			githubPrivateKey: "test-private-key",
			githubWebhookSecret: "test-webhook-secret",
			host: "127.0.0.1",
			logLevel: "error",
			port: 3000,
			ticketPmToken: "test-ticketpm-token"
		},
		createLogger("test", { level: "error", write: () => undefined })
	);
}
