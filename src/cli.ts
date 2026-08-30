import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnvironment } from "dotenv";
import { normalizeConfig } from "@/config/normalize.js";
import { readRuntimeEnvironment } from "@/core/environment.js";
import { createLogger } from "@/core/logger.js";
import { createConsistentBackup } from "@/db/backups.js";
import { createDatabase } from "@/db/client.js";
import config from "../config/config.js";

loadEnvironment({ path: "./config/.env", quiet: true });

const logger = createLogger("cli");

async function main() {
	const [command = "help", ...arguments_] = process.argv.slice(2);
	if (command === "help") {
		printHelp();
		return;
	}
	if (command === "config-migrate") {
		const normalized = normalizeConfig(config);
		const mode = arguments_.includes("--write") ? "write" : "preview";
		logger.info(
			mode === "write"
				? `Configuration is already at ${normalized.version}; no rewrite was necessary.`
				: `Configuration migration preview: ${normalized.version} is current.`
		);
		return;
	}

	const environment = readRuntimeEnvironment(process.env);
	const database = await createDatabase(environment, logger);
	try {
		if (command === "backup") {
			await assertNoActiveLease(database.client);
			await createConsistentBackup({
				client: database.client,
				databaseUrl: environment.databaseUrl,
				logger,
				retainCount: normalizeConfig(config).maintenance.localBackupCount
			});
			return;
		}
		if (command === "recovery-preview") {
			await recoveryPreview(database.client, arguments_[0]);
			return;
		}
		if (command === "mapping-cleanup") {
			const mappingKey = requiredArgument(arguments_[0], "mapping key");
			const apply = arguments_.includes("--apply");
			const confirmationIndex = arguments_.indexOf("--confirm");
			const confirmation = confirmationIndex >= 0 ? arguments_[confirmationIndex + 1] : undefined;
			if (apply) {
				await assertNoActiveLease(database.client);
			}
			await mappingCleanup(database.client, mappingKey, apply, confirmation);
			return;
		}
		throw new Error(`Unknown command "${command}". Run "bun run cli -- help".`);
	} finally {
		database.close();
	}
}

async function assertNoActiveLease(client: Awaited<ReturnType<typeof createDatabase>>["client"]) {
	const result = await client.execute({
		sql: "SELECT instance_id, host_label FROM worker_leases WHERE expires_at > ? LIMIT 1",
		args: [Date.now()]
	});
	if (result.rows[0]) {
		throw new Error(
			`A Forum Relay worker lease is active on ${String(result.rows[0].host_label)}. Stop the bot before mutating offline state.`
		);
	}
}

async function recoveryPreview(client: Awaited<ReturnType<typeof createDatabase>>["client"], requestedMapping?: string) {
	const result = await client.execute({
		sql: `
			SELECT mapping_key,
				COUNT(*) AS links,
				SUM(CASE WHEN discord_thread_id IS NULL THEN 1 ELSE 0 END) AS missing_discord_relationships,
				SUM(CASE WHEN status != 'ACTIVE' THEN 1 ELSE 0 END) AS non_active
			FROM issue_thread_links
			${requestedMapping ? "WHERE mapping_key = ?" : ""}
			GROUP BY mapping_key
		`,
		args: requestedMapping ? [requestedMapping] : []
	});
	logger.info("Relationship recovery preview.", {
		mappings: result.rows.map((row) => ({
			links: Number(row.links),
			mappingKey: String(row.mapping_key),
			missingDiscordRelationships: Number(row.missing_discord_relationships),
			nonActive: Number(row.non_active)
		}))
	});
}

async function mappingCleanup(
	client: Awaited<ReturnType<typeof createDatabase>>["client"],
	mappingKey: string,
	apply: boolean,
	confirmation?: string
) {
	const tables = [
		"label_bindings",
		"mapping_cursors",
		"mapping_webhooks",
		"bootstrap_jobs",
		"reconciliation_runs",
		"audit_classification_jobs",
		"inbox_events",
		"outbox_operations",
		"issue_thread_links",
		"relay_items"
	] as const;
	const counts: Record<string, number> = {};
	for (const table of tables) {
		const result = await client.execute({
			sql: `SELECT COUNT(*) AS count FROM ${table} WHERE mapping_key = ?`,
			args: [mappingKey]
		});
		counts[table] = Number(result.rows[0]?.count ?? 0);
	}
	logger.warn("Mapping cleanup preview.", { apply, counts, mappingKey });
	if (!apply) {
		logger.info(`To apply, rerun with --apply --confirm "DELETE ${mappingKey}".`);
		return;
	}
	if (confirmation !== `DELETE ${mappingKey}`) {
		throw new Error(`Cleanup confirmation must exactly equal "DELETE ${mappingKey}".`);
	}

	const exportDirectory = join(process.cwd(), ".data", "cleanup-exports");
	mkdirSync(exportDirectory, { recursive: true });
	const exportPath = join(exportDirectory, `${mappingKey}-${new Date().toISOString().replaceAll(":", "-")}.json`);
	const links = await client.execute({ sql: "SELECT * FROM issue_thread_links WHERE mapping_key = ?", args: [mappingKey] });
	writeFileSync(exportPath, JSON.stringify({ mappingKey, counts, links: links.rows }, null, 2), { flag: "wx" });

	const transaction = await client.transaction("write");
	try {
		await transaction.execute({
			sql: `
				DELETE FROM operation_dependencies WHERE operation_id IN (
					SELECT id FROM outbox_operations WHERE mapping_key = ?
				) OR depends_on_operation_id IN (
					SELECT id FROM outbox_operations WHERE mapping_key = ?
				)
			`,
			args: [mappingKey, mappingKey]
		});
		await transaction.execute({
			sql: "DELETE FROM operation_ledger WHERE outbox_operation_id IN (SELECT id FROM outbox_operations WHERE mapping_key = ?)",
			args: [mappingKey]
		});
		await transaction.execute({
			sql: "DELETE FROM relay_segments WHERE relay_item_id IN (SELECT id FROM relay_items WHERE mapping_key = ?)",
			args: [mappingKey]
		});
		await transaction.execute({
			sql: "DELETE FROM revision_shadows WHERE relay_item_id IN (SELECT id FROM relay_items WHERE mapping_key = ?)",
			args: [mappingKey]
		});
		await transaction.execute({
			sql: "DELETE FROM attachment_links WHERE relay_item_id IN (SELECT id FROM relay_items WHERE mapping_key = ?)",
			args: [mappingKey]
		});
		for (const table of [
			"relay_items",
			"outbox_operations",
			"inbox_events",
			"issue_thread_links",
			"audit_classification_jobs",
			"reconciliation_runs",
			"bootstrap_jobs",
			"label_bindings",
			"mapping_cursors",
			"mapping_webhooks"
		]) {
			await transaction.execute({ sql: `DELETE FROM ${table} WHERE mapping_key = ?`, args: [mappingKey] });
		}
		await transaction.execute({ sql: "DELETE FROM mappings WHERE key = ?", args: [mappingKey] });
		await transaction.commit();
	} catch (error) {
		await transaction.rollback();
		throw error;
	}
	logger.warn("Mapping cleanup applied.", { exportPath, mappingKey });
}

function requiredArgument(value: string | undefined, label: string) {
	if (!value) {
		throw new Error(`Missing ${label}.`);
	}
	return value;
}

function printHelp() {
	console.log(`Forum Relay offline CLI

  bun run cli -- config-migrate [--write]
  bun run cli -- backup
  bun run cli -- recovery-preview [mapping]
  bun run cli -- mapping-cleanup <mapping> [--apply --confirm "DELETE <mapping>"]

Mutating database commands refuse to run while a worker lease is active.`);
}

main().catch((error) => {
	logger.error("CLI command failed.", { error: error instanceof Error ? error : String(error) });
	process.exitCode = 1;
});
