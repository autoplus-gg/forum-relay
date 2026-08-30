import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Client, createClient } from "@libsql/client";
import type { Logger } from "@/core/logger.js";

const SQLITE_HEADER = "SQLite format 3\u0000";

export interface BackupResult {
	path: string;
	size: number;
	verifiedAt: Date;
}

export function createPreMigrationBackup(databaseUrl: string, logger: Logger) {
	const databasePath = resolveLocalDatabasePath(databaseUrl);

	if (!databasePath || !existsSync(databasePath) || statSync(databasePath).size === 0) {
		return undefined;
	}

	const backupDirectory = join(dirname(databasePath), "backups");
	mkdirSync(backupDirectory, { recursive: true });
	const backupPath = join(backupDirectory, `${basename(databasePath)}.pre-migration-${fileSafeTimestamp(new Date())}.bak`);
	copyFileSync(databasePath, backupPath);
	verifySqliteHeader(backupPath);
	logger.info(`Created pre-migration database backup at ${backupPath}.`);

	return {
		path: backupPath,
		size: statSync(backupPath).size,
		verifiedAt: new Date()
	} satisfies BackupResult;
}

export async function createConsistentBackup(options: {
	client: Client;
	databaseUrl: string;
	logger: Logger;
	retainCount: number;
}) {
	const databasePath = resolveLocalDatabasePath(options.databaseUrl);

	if (!databasePath) {
		options.logger.info("Skipping local backup because the database is remote.");
		return undefined;
	}

	const backupDirectory = join(dirname(databasePath), "backups");
	mkdirSync(backupDirectory, { recursive: true });
	const backupPath = join(backupDirectory, `${basename(databasePath)}.daily-${fileSafeTimestamp(new Date())}.db`);
	const sqlPath = backupPath.replaceAll("'", "''");
	await options.client.execute(`VACUUM INTO '${sqlPath}'`);
	await verifySqliteDatabase(backupPath);
	pruneBackups(backupDirectory, basename(databasePath), options.retainCount);
	options.logger.info(`Created verified database backup at ${backupPath}.`);

	return {
		path: backupPath,
		size: statSync(backupPath).size,
		verifiedAt: new Date()
	} satisfies BackupResult;
}

export function resolveLocalDatabasePath(databaseUrl: string) {
	if (!databaseUrl.startsWith("file:")) {
		return undefined;
	}

	const rawPath = databaseUrl.slice("file:".length);

	if (rawPath.startsWith("//")) {
		return fileURLToPath(databaseUrl);
	}

	return isAbsolute(rawPath) ? rawPath : resolve(rawPath);
}

function verifySqliteHeader(path: string) {
	const header = readFileSync(path).subarray(0, 16).toString("utf8");

	if (header !== SQLITE_HEADER) {
		throw new Error(`Backup ${path} is not a valid SQLite database.`);
	}
}

async function verifySqliteDatabase(path: string) {
	verifySqliteHeader(path);
	const verificationClient = createClient({ url: `file:${path}` });

	try {
		const result = await verificationClient.execute("PRAGMA integrity_check");
		if (result.rows[0]?.integrity_check !== "ok") {
			throw new Error(`SQLite integrity verification failed for ${path}.`);
		}
	} finally {
		verificationClient.close();
	}
}

function pruneBackups(directory: string, databaseFilename: string, retainCount: number) {
	const candidates = readdirSync(directory)
		.filter((name) => name.startsWith(`${databaseFilename}.daily-`) && name.endsWith(".db"))
		.map((name) => ({
			name,
			path: join(directory, name),
			createdAt: statSync(join(directory, name)).birthtimeMs
		}))
		.sort((left, right) => right.createdAt - left.createdAt);

	for (const candidate of candidates.slice(retainCount)) {
		unlinkSync(candidate.path);
	}
}

function fileSafeTimestamp(value: Date) {
	return value.toISOString().replaceAll(":", "-");
}
