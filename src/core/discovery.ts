import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GatewayDispatchEvents } from "@discordjs/core";
import type { Logger } from "@/core/logger.js";
import type { CommandModule, EventModule, FeatureModule } from "@/core/types.js";

const srcDirectory = fileURLToPath(new URL("..", import.meta.url));
const featuresDirectory = join(srcDirectory, "features");
const eventsDirectory = join(srcDirectory, "events");

type RuntimePrimitive = bigint | boolean | null | number | string | symbol | undefined;
type RuntimeCallable = (...arguments_: never[]) => void;
interface RuntimeRecord {
	readonly [key: string]: RuntimeValue;
}
type RuntimeValue = RuntimePrimitive | RuntimeCallable | RuntimeRecord | CommandModule | EventModule | FeatureModule;

function isObject(value: RuntimeValue): value is RuntimeRecord | CommandModule | EventModule | FeatureModule {
	return typeof value === "object" && value !== null;
}

function isCommandModule(value: RuntimeValue): value is CommandModule {
	return (
		isObject(value) &&
		"data" in value &&
		typeof value.data === "object" &&
		value.data !== null &&
		"execute" in value &&
		typeof value.execute === "function"
	);
}

function isFeatureModule(value: RuntimeValue): value is FeatureModule {
	return isObject(value) && "key" in value && typeof value.key === "string";
}

function isEventModule(value: RuntimeValue): value is EventModule {
	if (!isObject(value) || !("name" in value) || !("execute" in value) || typeof value.execute !== "function") {
		return false;
	}

	return value.name === GatewayDispatchEvents.Ready || value.name === GatewayDispatchEvents.InteractionCreate;
}

function isModuleFile(filePath: string) {
	return filePath.endsWith(".ts") || filePath.endsWith(".js");
}

async function walkFiles(rootDirectory: string): Promise<string[]> {
	const entries = await readdir(rootDirectory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const absolutePath = join(rootDirectory, entry.name);
			return entry.isDirectory() ? walkFiles(absolutePath) : [absolutePath];
		})
	);

	return files.flat();
}

async function importModules<TModule extends RuntimeValue>(
	directory: string,
	matcher: (filePath: string) => boolean,
	guard: (value: RuntimeValue) => value is TModule,
	logger: Logger,
	label: string
): Promise<TModule[]> {
	const filePaths = (await walkFiles(directory)).filter(matcher).sort();
	const loadedModules: TModule[] = [];

	for (const filePath of filePaths) {
		const importedModule: Record<string, RuntimeValue> = await import(pathToFileURL(filePath).href);
		const exportedValues = importedModule.default === undefined ? Object.values(importedModule) : [importedModule.default];

		for (const exportedValue of exportedValues) {
			if (guard(exportedValue)) {
				loadedModules.push(exportedValue);
			}
		}
	}

	logger.info(`Discovered ${loadedModules.length} ${label}.`);
	return loadedModules;
}

export function discoverFeatures(logger: Logger) {
	return importModules(
		featuresDirectory,
		(filePath) => isModuleFile(filePath) && /feature\.(?:ts|js)$/.test(filePath),
		isFeatureModule,
		logger,
		"features"
	);
}

export function discoverCommands(logger: Logger) {
	return importModules(
		featuresDirectory,
		(filePath) => isModuleFile(filePath) && /command\.(?:ts|js)$/.test(filePath),
		isCommandModule,
		logger,
		"commands"
	);
}

export function discoverEvents(logger: Logger) {
	return importModules(
		eventsDirectory,
		(filePath) => isModuleFile(filePath) && !/[\\/]index\.(?:ts|js)$/.test(filePath),
		isEventModule,
		logger,
		"events"
	);
}
