import { readFileSync } from "node:fs";

const PLACEHOLDER_PATTERNS = [/replace-me/i, /^123456$/, /^123456789012345678$/];
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeEnvironment {
	databaseAuthToken?: string;
	databaseUrl: string;
	discordToken: string;
	githubAppId: string;
	githubPrivateKey: string;
	githubWebhookSecret: string;
	host: string;
	logLevel: LogLevel;
	port: number;
	ticketPmToken?: string;
}

export function readRuntimeEnvironment(environment: NodeJS.ProcessEnv): RuntimeEnvironment {
	const discordToken = readSecret(environment, "DISCORD_TOKEN", "DISCORD_TOKEN_FILE");
	const githubAppId = readSecret(environment, "GITHUB_APP_ID", "GITHUB_APP_ID_FILE");
	const githubWebhookSecret = readSecret(environment, "GITHUB_WEBHOOK_SECRET", "GITHUB_WEBHOOK_SECRET_FILE");
	const ticketPmToken = readOptionalSecret(environment, "TICKETPM_TOKEN", "TICKETPM_TOKEN_FILE");
	const databaseUrl = requireValue(environment.DB_FILE_NAME, "DB_FILE_NAME");
	const databaseAuthToken = readOptionalSecret(environment, "DB_AUTH_TOKEN", "DB_AUTH_TOKEN_FILE");
	const githubPrivateKey = readPrivateKey(environment);
	const port = parsePort(environment.PORT ?? "3000");
	const logLevel = parseLogLevel(environment.LOG_LEVEL ?? "info");

	for (const [name, value] of [
		["DISCORD_TOKEN", discordToken],
		["GITHUB_APP_ID", githubAppId],
		["GITHUB_WEBHOOK_SECRET", githubWebhookSecret]
	] as const) {
		if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
			throw new Error(`${name} still contains an example placeholder.`);
		}
	}
	if (ticketPmToken && PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(ticketPmToken))) {
		throw new Error("TICKETPM_TOKEN still contains an example placeholder.");
	}

	return {
		databaseAuthToken,
		databaseUrl,
		discordToken,
		githubAppId,
		githubPrivateKey,
		githubWebhookSecret,
		host: environment.HOST?.trim() || "0.0.0.0",
		logLevel,
		port,
		ticketPmToken
	};
}

function readPrivateKey(environment: NodeJS.ProcessEnv) {
	const path = environment.GITHUB_PRIVATE_KEY_PATH?.trim();
	const encoded = environment.GITHUB_PRIVATE_KEY_BASE64?.trim();

	if (path && encoded) {
		throw new Error("Set exactly one of GITHUB_PRIVATE_KEY_PATH or GITHUB_PRIVATE_KEY_BASE64.");
	}

	if (path) {
		return requireValue(readFileSync(path, "utf8"), "GITHUB_PRIVATE_KEY_PATH contents");
	}

	if (encoded) {
		return requireValue(Buffer.from(encoded, "base64").toString("utf8"), "GITHUB_PRIVATE_KEY_BASE64 contents");
	}

	throw new Error("Missing GitHub private key. Set GITHUB_PRIVATE_KEY_PATH or GITHUB_PRIVATE_KEY_BASE64.");
}

function readSecret(environment: NodeJS.ProcessEnv, valueName: keyof NodeJS.ProcessEnv, fileName: keyof NodeJS.ProcessEnv) {
	const value = environment[valueName]?.trim();
	const path = environment[fileName]?.trim();

	if (value && path) {
		throw new Error(`Set only one of ${String(valueName)} or ${String(fileName)}.`);
	}

	if (path) {
		return requireValue(readFileSync(path, "utf8").trim(), String(fileName));
	}

	return requireValue(value, String(valueName));
}

function readOptionalSecret(
	environment: NodeJS.ProcessEnv,
	valueName: keyof NodeJS.ProcessEnv,
	fileName: keyof NodeJS.ProcessEnv
) {
	const value = environment[valueName]?.trim();
	const path = environment[fileName]?.trim();

	if (value && path) {
		throw new Error(`Set only one of ${String(valueName)} or ${String(fileName)}.`);
	}

	if (path) {
		return requireValue(readFileSync(path, "utf8").trim(), String(fileName));
	}

	return value || undefined;
}

function requireValue(value: string | undefined, name: string) {
	if (!value?.trim()) {
		throw new Error(`${name} is required.`);
	}

	return value.trim();
}

function parsePort(value: string) {
	const port = Number.parseInt(value, 10);

	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("PORT must be an integer between 1 and 65535.");
	}

	return port;
}

function parseLogLevel(value: string): LogLevel {
	switch (value) {
		case "debug":
		case "info":
		case "warn":
		case "error":
			return value;
	}

	throw new Error("LOG_LEVEL must be debug, info, warn, or error.");
}
