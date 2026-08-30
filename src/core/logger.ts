import type { LogLevel } from "@/core/environment.js";

export type DiagnosticScalar = boolean | Date | Error | null | number | string;
export type DiagnosticValue =
	| DiagnosticScalar
	| readonly DiagnosticValue[]
	| { readonly [key: string]: DiagnosticValue | undefined };
export type DiagnosticFields = Readonly<Record<string, DiagnosticValue | undefined>>;

export interface Logger {
	debug(message: string, fields?: DiagnosticFields): void;
	error(message: string, fields?: DiagnosticFields): void;
	info(message: string, fields?: DiagnosticFields): void;
	warn(message: string, fields?: DiagnosticFields): void;
	child(fields: DiagnosticFields): Logger;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};
const SECRET_KEY_PATTERN = /(authorization|cookie|private.?key|secret|signature|token)/i;
const SIGNED_QUERY_PARAMETER_PATTERN = /([?&](?:sig|signature|token|x-amz-[^=]+)=)[^&\s]+/gi;

export interface LoggerOptions {
	level?: LogLevel;
	write?(line: string): void;
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
	return createScopedLogger(scope, options.level ?? "info", options.write ?? console.log, {});
}

function createScopedLogger(
	scope: string,
	minimumLevel: LogLevel,
	writeLine: (line: string) => void,
	boundFields: DiagnosticFields
): Logger {
	function write(level: LogLevel, message: string, fields: DiagnosticFields = {}) {
		if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[minimumLevel]) {
			return;
		}

		writeLine(
			JSON.stringify({
				timestamp: new Date().toISOString(),
				level,
				scope,
				message: redactString(message),
				...redactFields(boundFields),
				...redactFields(fields)
			})
		);
	}

	return {
		debug: (message, fields) => write("debug", message, fields),
		error: (message, fields) => write("error", message, fields),
		info: (message, fields) => write("info", message, fields),
		warn: (message, fields) => write("warn", message, fields),
		child: (fields) => createScopedLogger(scope, minimumLevel, writeLine, { ...boundFields, ...fields })
	};
}

function redactFields(fields: DiagnosticFields): DiagnosticFields {
	return Object.fromEntries(
		Object.entries(fields).map(([key, value]) => [
			key,
			SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : value === undefined ? undefined : redactValue(value)
		])
	);
}

function redactValue(value: DiagnosticValue): DiagnosticValue {
	if (typeof value === "string") {
		return redactString(value);
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	if (value instanceof Error) {
		return {
			name: value.name,
			message: redactString(value.message),
			stack: value.stack ? redactString(value.stack) : undefined
		};
	}

	if (isDiagnosticArray(value)) {
		return value.map(redactValue);
	}

	if (value && typeof value === "object") {
		return redactFields(value);
	}

	return value;
}

function isDiagnosticArray(value: DiagnosticValue): value is readonly DiagnosticValue[] {
	return Array.isArray(value);
}

function redactString(value: string) {
	return value
		.replaceAll(/(bearer\s+)[a-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
		.replaceAll(SIGNED_QUERY_PARAMETER_PATTERN, "$1[REDACTED]");
}
