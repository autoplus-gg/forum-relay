import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: "./config/.env", quiet: true });

// Schema-only CI commands still load this file even though they never connect.
// Runtime startup validates DB_FILE_NAME separately.
const databaseUrl = process.env.DB_FILE_NAME ?? "file:.data/forum-relay.db";

if (databaseUrl.startsWith("file:")) {
	const databasePath = databaseUrl.slice("file:".length);
	const databaseDirectory = dirname(isAbsolute(databasePath) ? databasePath : resolve(databasePath));

	mkdirSync(databaseDirectory, { recursive: true });
}

export default defineConfig({
	out: "./src/db/migrations",
	schema: "./src/db/schema.ts",
	dialect: "sqlite",
	dbCredentials: {
		url: databaseUrl
	}
});
