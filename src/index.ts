import { config as loadEnvironment } from "dotenv";
import { createBotApp } from "@/app.js";
import { readRuntimeEnvironment } from "@/core/environment.js";
import { createLogger } from "@/core/logger.js";
import { containsTerminalInterrupt } from "@/core/process-control.js";
import { BOT_VERSION } from "@/version.js";

const logger = createLogger("boot");
const SHUTDOWN_SIGNALS = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM", "SIGUSR1", "SIGUSR2"] as const;
let stopApplication: (() => Promise<void>) | undefined;
let shutdownTask: Promise<void> | undefined;

loadEnvironment({ path: "./config/.env", quiet: true });

function requestShutdown(reason: string, exitCode: number) {
	if (shutdownTask) {
		logger.warn("Shutdown is already in progress.", { reason });
		return;
	}

	logger.info("Graceful shutdown requested.", { reason });
	shutdownTask = (async () => {
		let finalExitCode = exitCode;
		try {
			await stopApplication?.();
		} catch (error) {
			finalExitCode = 1;
			logger.error("Graceful shutdown failed.", {
				error: error instanceof Error ? error : String(error),
				reason
			});
		} finally {
			process.exit(finalExitCode);
		}
	})();
}

for (const signal of SHUTDOWN_SIGNALS) {
	process.on(signal, () => requestShutdown(signal, 0));
}

// The generic Pterodactyl/Pelican Bun egg writes ETX (`^^C`) to stdin instead of
// guaranteeing an OS-level SIGINT, so handle both representations.
process.stdin.on("data", (chunk: Buffer) => {
	if (containsTerminalInterrupt(chunk)) {
		requestShutdown("stdinControlC", 0);
	}
});
process.stdin.resume();

process.on("uncaughtException", (error) => {
	logger.error("Uncaught exception.", { error });
	requestShutdown("uncaughtException", 1);
});

process.on("unhandledRejection", (error) => {
	logger.error("Unhandled promise rejection.", {
		error: error instanceof Error ? error : String(error)
	});
	requestShutdown("unhandledRejection", 1);
});

async function main() {
	const environment = readRuntimeEnvironment(process.env);
	const application = await createBotApp(environment);
	stopApplication = application.stop;

	logger.info(`Starting Forum Relay ${BOT_VERSION}.`);
	await application.start();
}

main().catch((error) => {
	logger.error("Forum Relay failed to start.", {
		error: error instanceof Error ? error : String(error)
	});
	requestShutdown("startupFailure", 1);
});
