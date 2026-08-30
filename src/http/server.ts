import type { NormalizedConfig } from "@/config/normalize.js";
import type { RuntimeEnvironment } from "@/core/environment.js";
import type { Logger } from "@/core/logger.js";
import type { JobRepository } from "@/db/job-repository.js";
import { normalizeGitHubWebhook, verifyGitHubSignature } from "@/github/webhook.js";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

export interface ReadinessState {
	database: boolean;
	discord: boolean;
	github: boolean;
	lease: boolean;
}

export interface HttpServerOptions {
	config: NormalizedConfig;
	environment: RuntimeEnvironment;
	jobs: Pick<JobRepository, "enqueueInbox">;
	logger: Logger;
	readiness: ReadinessState;
}

export class RelayHttpServer {
	readonly #options: HttpServerOptions;
	#server?: Bun.Server<undefined>;

	public constructor(options: HttpServerOptions) {
		this.#options = options;
	}

	public start() {
		if (this.#server) {
			return;
		}

		this.#server = Bun.serve({
			hostname: this.#options.environment.host,
			port: this.#options.environment.port,
			fetch: (request) => this.handle(request)
		});
		this.#options.logger.info("HTTP server listening.", {
			githubWebhookUrl: new URL("/webhooks/github", this.#options.config.publicBaseUrl).toString(),
			host: this.#options.environment.host,
			port: this.#server.port
		});
	}

	public stop() {
		this.#server?.stop(true);
		this.#server = undefined;
	}

	public async handle(request: Request) {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health/live") {
			return jsonResponse({ live: true }, 200);
		}
		if (request.method === "GET" && url.pathname === "/health/ready") {
			const ready = Object.values(this.#options.readiness).every(Boolean);
			return jsonResponse({ ready, checks: this.#options.readiness }, ready ? 200 : 503);
		}
		if (request.method === "POST" && url.pathname === "/webhooks/github") {
			return this.#githubWebhook(request);
		}
		if (request.method === "POST") {
			this.#options.logger.warn("Rejected POST to an unknown HTTP route.", {
				path: url.pathname
			});
		}
		return jsonResponse({ error: "not_found" }, 404);
	}

	async #githubWebhook(request: Request) {
		const deliveryId = request.headers.get("x-github-delivery") ?? "";
		const eventName = request.headers.get("x-github-event") ?? "";
		const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLocaleLowerCase("en-US");
		if (contentType !== "application/json") {
			this.#options.logger.warn("Rejected GitHub webhook with an unsupported content type.", {
				contentType: contentType ?? "missing",
				deliveryId,
				eventName
			});
			return jsonResponse({ error: "unsupported_media_type" }, 415);
		}
		const contentLength = Number(request.headers.get("content-length") ?? "0");
		if (contentLength > MAX_WEBHOOK_BYTES) {
			this.#options.logger.warn("Rejected oversized GitHub webhook.", {
				contentLength,
				deliveryId,
				eventName
			});
			return jsonResponse({ error: "payload_too_large" }, 413);
		}

		const bytes = new Uint8Array(await request.arrayBuffer());
		if (bytes.byteLength > MAX_WEBHOOK_BYTES) {
			this.#options.logger.warn("Rejected oversized GitHub webhook.", {
				contentLength: bytes.byteLength,
				deliveryId,
				eventName
			});
			return jsonResponse({ error: "payload_too_large" }, 413);
		}

		const signature = request.headers.get("x-hub-signature-256") ?? "";
		if (!verifyGitHubSignature(bytes, signature, this.#options.environment.githubWebhookSecret)) {
			this.#options.logger.warn("Rejected GitHub webhook with an invalid signature.", {
				deliveryId,
				eventName
			});
			return jsonResponse({ error: "invalid_signature" }, 401);
		}

		try {
			const normalized = normalizeGitHubWebhook(this.#options.config, deliveryId, eventName, new TextDecoder().decode(bytes));
			if (normalized.reason) {
				this.#options.logger.info("Ignored GitHub webhook.", {
					deliveryId,
					eventKind: normalized.event.eventKind,
					eventName,
					reason: normalized.reason
				});
				return jsonResponse({ accepted: true, ignored: normalized.reason }, 202);
			}

			const inserted = await this.#options.jobs.enqueueInbox(normalized.event);
			this.#options.logger.info("Accepted GitHub webhook.", {
				deliveryId,
				duplicate: !inserted,
				eventKind: normalized.event.eventKind,
				eventName,
				mappingKey: normalized.mappingKey
			});
			return jsonResponse({ accepted: true, duplicate: !inserted }, 202);
		} catch (error) {
			this.#options.logger.warn("Rejected malformed GitHub webhook.", {
				deliveryId,
				error: error instanceof Error ? error : String(error)
			});
			return jsonResponse({ error: "invalid_payload" }, 400);
		}
	}
}

function jsonResponse(value: object, status: number) {
	return Response.json(value, {
		status,
		headers: {
			"cache-control": "no-store",
			"x-content-type-options": "nosniff"
		}
	});
}
