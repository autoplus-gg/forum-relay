import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

let database: Database | undefined;
afterEach(() => database?.close());

describe("thread-create serialization recovery migration", () => {
	it("requeues only operations killed by the former channel_id bug", () => {
		database = new Database(":memory:");
		database.exec(`
			CREATE TABLE outbox_operations (
				id TEXT PRIMARY KEY NOT NULL,
				operation_kind TEXT NOT NULL,
				state TEXT NOT NULL,
				attempt_count INTEGER NOT NULL,
				next_attempt_at INTEGER,
				claim_owner TEXT,
				claim_expires_at INTEGER,
				last_error_code TEXT,
				last_error_message TEXT
			);
		`);
		const insert = database.query<void, [id: string, operationKind: string, errorCode: string, errorMessage: string]>(`
			INSERT INTO outbox_operations (
				id, operation_kind, state, attempt_count, next_attempt_at,
				claim_owner, claim_expires_at, last_error_code, last_error_message
			) VALUES (?, ?, 'dead', 1, NULL, 'old-worker', 123, ?, ?)
		`);
		insert.run("affected", "github.issue.create", "PAYLOAD_INVALID", "Expected channel_id to be a string.");
		insert.run("unrelated", "github.issue.create", "PAYLOAD_INVALID", "Expected id to be a string.");

		const migrationPath = fileURLToPath(
			new URL("../../src/db/migrations/0002_retry_thread_create_serialization.sql", import.meta.url)
		);
		database.exec(readFileSync(migrationPath, "utf8"));
		const rows = database
			.query<{ attempt_count: number; id: string; state: string }, []>(
				"SELECT id, state, attempt_count FROM outbox_operations ORDER BY id"
			)
			.all();

		expect(rows).toEqual([
			{ attempt_count: 0, id: "affected", state: "pending" },
			{ attempt_count: 1, id: "unrelated", state: "dead" }
		]);
	});
});
