import { type Client, GatewayDispatchEvents } from "@discordjs/core";
import type { Client as DatabaseClient } from "@libsql/client";
import type { NormalizedConfig } from "@/config/normalize.js";
import type { JsonValue } from "@/core/json.js";
import type { Logger } from "@/core/logger.js";
import type { JobRepository } from "@/db/job-repository.js";
import { discordEventIdempotencyKey } from "@/discord/event-idempotency.js";
import { shouldIgnoreDiscordMessage } from "@/discord/message-origin.js";

export class DiscordEventIntake {
	readonly #client: Client;
	readonly #config: NormalizedConfig;
	readonly #database: DatabaseClient;
	readonly #jobs: JobRepository;
	readonly #logger: Logger;
	readonly #threadMappings = new Map<string, string>();

	public constructor(client: Client, database: DatabaseClient, config: NormalizedConfig, jobs: JobRepository, logger: Logger) {
		this.#client = client;
		this.#database = database;
		this.#config = config;
		this.#jobs = jobs;
		this.#logger = logger;
	}

	public register() {
		this.#client.on(GatewayDispatchEvents.ThreadCreate, (event) => {
			const mappingKey = this.#mappingForForum(event.data.parent_id);
			if (mappingKey) {
				this.#threadMappings.set(event.data.id, mappingKey);
				void this.#enqueue(mappingKey, "thread.create", event.data.id, event.data.id, event.data);
			}
		});
		this.#client.on(GatewayDispatchEvents.ThreadUpdate, (event) => {
			const mappingKey = this.#mappingForForum(event.data.parent_id);
			if (mappingKey) {
				this.#threadMappings.set(event.data.id, mappingKey);
				void this.#enqueue(mappingKey, "thread.update", event.data.id, event.data.id, event.data);
			}
		});
		this.#client.on(GatewayDispatchEvents.ThreadDelete, (event) => {
			const mappingKey = this.#mappingForForum(event.data.parent_id);
			if (mappingKey) {
				void this.#enqueue(mappingKey, "thread.delete", event.data.id, event.data.id, event.data);
			}
		});
		this.#client.on(GatewayDispatchEvents.MessageCreate, (event) => {
			if (shouldIgnoreDiscordMessage(event.data, this.#config.clientId)) {
				return;
			}
			void this.#enqueueForThread("message.create", event.data.channel_id, event.data.id, event.data);
		});
		this.#client.on(GatewayDispatchEvents.MessageUpdate, (event) => {
			if (shouldIgnoreDiscordMessage(event.data, this.#config.clientId)) {
				return;
			}
			void this.#enqueueForThread("message.update", event.data.channel_id, event.data.id, event.data);
		});
		this.#client.on(GatewayDispatchEvents.MessageDelete, (event) => {
			void this.#enqueueForThread("message.delete", event.data.channel_id, event.data.id, event.data);
		});
	}

	async #enqueueForThread(kind: string, threadId: string, sourceId: string, payload: object) {
		const mappingKey = await this.#mappingForThread(threadId);
		if (mappingKey) {
			await this.#enqueue(mappingKey, kind, threadId, sourceId, payload);
		}
	}

	async #mappingForThread(threadId: string) {
		const cached = this.#threadMappings.get(threadId);
		if (cached) {
			return cached;
		}
		const result = await this.#database.execute({
			sql: "SELECT mapping_key FROM issue_thread_links WHERE discord_thread_id = ?",
			args: [threadId]
		});
		const mappingKey = result.rows[0]?.mapping_key;
		if (typeof mappingKey === "string") {
			this.#threadMappings.set(threadId, mappingKey);
			return mappingKey;
		}
		return undefined;
	}

	#mappingForForum(forumId: string | null | undefined) {
		if (!forumId) {
			return undefined;
		}
		return Object.entries(this.#config.mappings).find(([, mapping]) => mapping.forumChannelId === forumId)?.[0];
	}

	async #enqueue(mappingKey: string, kind: string, threadId: string, sourceId: string, payload: object) {
		try {
			const normalizedPayload = jsonRoundTrip(payload);
			await this.#jobs.enqueueInbox({
				eventKind: kind,
				idempotencyKey: discordEventIdempotencyKey(kind, sourceId, normalizedPayload),
				mappingKey,
				partitionKey: `discord:thread:${threadId}`,
				payload: normalizedPayload,
				platform: "discord"
			});
		} catch (error) {
			this.#logger.error("Failed to persist Discord Gateway event.", {
				error: error instanceof Error ? error : String(error),
				eventKind: kind,
				sourceId
			});
		}
	}
}

function jsonRoundTrip(value: object): JsonValue {
	const result: JsonValue = JSON.parse(JSON.stringify(value));
	return result;
}
