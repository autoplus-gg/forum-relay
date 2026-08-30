import { fileURLToPath } from "node:url";
import { type Client, createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { RuntimeEnvironment } from "@/core/environment.js";
import type { Logger } from "@/core/logger.js";
import * as schema from "@/db/schema.js";

export interface DatabaseContext {
	client: Client;
	db: LibSQLDatabase<typeof schema>;
	close(): void;
}

export async function createDatabase(environment: RuntimeEnvironment, logger: Logger): Promise<DatabaseContext> {
	const client = createClient({
		url: environment.databaseUrl,
		authToken: environment.databaseAuthToken
	});
	const db = drizzle(client, { schema });

	await migrate(db, {
		migrationsFolder: fileURLToPath(new URL("./migrations", import.meta.url))
	});
	logger.info("Database migrations are current.");

	return {
		client,
		db,
		close() {
			client.close();
		}
	};
}
