import type { Client } from "@discordjs/core";
import type { Client as DatabaseClient } from "@libsql/client";
import { type APIThreadChannel, type APIWebhook, AuditLogEvent, ChannelType } from "discord-api-types/v10";
import type { NormalizedConfig } from "@/config/normalize.js";
import type { JsonObject, JsonValue } from "@/core/json.js";
import type { Logger } from "@/core/logger.js";
import type { DiscordRenderPayload } from "@/discord/components.js";
import { webhookMessageBody } from "@/discord/components.js";
import { forumRelayWebhookName, isReusableForumRelayWebhook, isStoredForumRelayWebhook } from "@/discord/webhook-selection.js";
import { RelayFailure } from "@/jobs/retry-policy.js";
import { planDiscordForumTags } from "@/labels/bindings.js";

export interface MappingWebhook {
	applicationId: string;
	channelId: string;
	id: string;
	token: string;
}

export class DiscordClient {
	readonly #client: Client;
	readonly #config: NormalizedConfig;
	readonly #database: DatabaseClient;
	readonly #logger: Logger;
	readonly #webhooks = new Map<string, MappingWebhook>();

	public constructor(client: Client, database: DatabaseClient, config: NormalizedConfig, logger: Logger) {
		this.#client = client;
		this.#database = database;
		this.#config = config;
		this.#logger = logger;
	}

	public async initializeMappings() {
		const results = new Map<string, MappingWebhook | Error>();
		for (const mappingKey of Object.keys(this.#config.mappings)) {
			try {
				results.set(mappingKey, await this.ensureWebhook(mappingKey));
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				results.set(mappingKey, normalized);
				await this.#markMappingFailure(mappingKey, normalized.message);
			}
		}
		return results;
	}

	public async validateForum(mappingKey: string) {
		const mapping = this.#mapping(mappingKey);
		const channel = await this.#client.api.channels.get(mapping.forumChannelId);
		if (channel.type !== ChannelType.GuildForum) {
			throw new RelayFailure(`Channel ${mapping.forumChannelId} is not a Discord Forum channel.`, "invalid", "DISCORD_NOT_FORUM");
		}
		return channel;
	}

	public async ensureWebhook(mappingKey: string) {
		const cached = this.#webhooks.get(mappingKey);
		if (cached) {
			return cached;
		}

		const stored = await this.#database.execute({
			sql: `
				SELECT webhook_id, webhook_token, application_id, channel_id
				FROM mapping_webhooks WHERE mapping_key = ?
			`,
			args: [mappingKey]
		});
		const row = stored.rows[0];
		if (row) {
			const webhook: MappingWebhook = {
				applicationId: String(row.application_id),
				channelId: String(row.channel_id),
				id: String(row.webhook_id),
				token: String(row.webhook_token)
			};
			try {
				const remote = await this.#client.api.webhooks.get(webhook.id, { token: webhook.token });
				if (isStoredForumRelayWebhook(remote, this.#config.clientId, this.#mapping(mappingKey).forumChannelId)) {
					this.#webhooks.set(mappingKey, webhook);
					return webhook;
				}
			} catch (error) {
				const failure = classifyDiscordError(error instanceof Error ? error : new Error(String(error)));
				if (failure.category !== "not-found") {
					throw failure;
				}
				this.#logger.warn("Stored Discord webhook is unavailable; creating a replacement.", { mappingKey });
			}
		}

		await this.validateForum(mappingKey);
		const mapping = this.#mapping(mappingKey);
		let remoteWebhooks: APIWebhook[];
		try {
			remoteWebhooks = await this.#client.api.channels.getWebhooks(mapping.forumChannelId);
		} catch (error) {
			throw classifyDiscordError(error instanceof Error ? error : new Error(String(error)));
		}
		const reusable = remoteWebhooks.find((webhook) =>
			isReusableForumRelayWebhook(webhook, this.#config.clientId, mapping.forumChannelId, mappingKey)
		);
		if (reusable?.token && reusable.channel_id) {
			const webhook: MappingWebhook = {
				applicationId: reusable.application_id ?? this.#config.clientId,
				channelId: reusable.channel_id,
				id: reusable.id,
				token: reusable.token
			};
			await this.#persistWebhook(mappingKey, webhook);
			this.#webhooks.set(mappingKey, webhook);
			this.#logger.info("Adopted an existing Forum Relay Discord webhook.", {
				mappingKey,
				webhookId: webhook.id
			});
			return webhook;
		}

		let created: APIWebhook;
		try {
			created = await this.#client.api.channels.createWebhook(mapping.forumChannelId, {
				name: forumRelayWebhookName(mappingKey)
			});
		} catch (error) {
			throw classifyDiscordError(error instanceof Error ? error : new Error(String(error)));
		}
		if (!created.token || !created.channel_id) {
			throw new RelayFailure(
				"Discord did not return an application-owned webhook token.",
				"authentication",
				"DISCORD_WEBHOOK_INVALID"
			);
		}
		const webhook: MappingWebhook = {
			applicationId: created.application_id ?? this.#config.clientId,
			channelId: created.channel_id,
			id: created.id,
			token: created.token
		};
		await this.#persistWebhook(mappingKey, webhook);
		this.#webhooks.set(mappingKey, webhook);
		return webhook;
	}

	async #persistWebhook(mappingKey: string, webhook: MappingWebhook) {
		const now = Date.now();
		await this.#database.execute({
			sql: `
				INSERT INTO mapping_webhooks (
					mapping_key, webhook_id, webhook_token, application_id, channel_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(mapping_key) DO UPDATE SET
					webhook_id = excluded.webhook_id,
					webhook_token = excluded.webhook_token,
					application_id = excluded.application_id,
					channel_id = excluded.channel_id,
					updated_at = excluded.updated_at
			`,
			args: [mappingKey, webhook.id, webhook.token, webhook.applicationId, webhook.channelId, now, now]
		});
	}

	public async syncForumTags(mappingKey: string) {
		const mapping = this.#mapping(mappingKey);
		const channel = await this.validateForum(mappingKey);
		const bindingResult = await this.#database.execute({
			sql: `
				SELECT position, configured_discord_name, discord_tag_id, state
				FROM label_bindings WHERE mapping_key = ? ORDER BY position
			`,
			args: [mappingKey]
		});
		const staleTagIds: Set<string> = new Set(
			bindingResult.rows.flatMap((row) =>
				row.state === "STALE_GITHUB" && typeof row.discord_tag_id === "string" ? [row.discord_tag_id] : []
			)
		);
		const activeRows = bindingResult.rows.filter((row) => row.state !== "STALE_GITHUB");
		const plan = planDiscordForumTags(
			channel.available_tags.map((tag) => ({
				emoji_id: tag.emoji_id ?? null,
				emoji_name: tag.emoji_name ?? null,
				id: tag.id,
				moderated: tag.moderated,
				name: tag.name
			})),
			activeRows.map((row) => ({
				desiredName: String(row.configured_discord_name),
				position: Number(row.position),
				storedTagId: typeof row.discord_tag_id === "string" ? row.discord_tag_id : undefined
			})),
			staleTagIds
		);

		const current = plan.changed
			? await this.#client.api.channels.edit(mapping.forumChannelId, {
					available_tags: plan.tags.map((tag) => ({
						emoji_id: tag.emoji_id ?? undefined,
						emoji_name: tag.emoji_name ?? undefined,
						id: tag.id.startsWith("new:") ? undefined : tag.id,
						moderated: tag.moderated,
						name: tag.name
					}))
				})
			: channel;
		if (current.type !== ChannelType.GuildForum) {
			throw new RelayFailure("Discord changed the mapped forum channel type.", "invalid", "DISCORD_NOT_FORUM");
		}

		const resolutions = new Map(plan.resolutions.map((resolution) => [resolution.position, resolution]));
		const now = Date.now();
		await this.#database.batch(
			[
				...activeRows.map((row) => {
					const position = Number(row.position);
					const resolution = resolutions.get(position);
					const tag = resolution?.tagId
						? current.available_tags.find((candidate) => candidate.id === resolution.tagId)
						: resolution
							? current.available_tags[resolution.submittedIndex]
							: undefined;
					return {
						sql: `
							UPDATE label_bindings SET discord_tag_id = ?, discord_current_name = ?,
								state = ?, updated_at = ? WHERE mapping_key = ? AND position = ?
						`,
						args: [tag?.id ?? null, tag?.name ?? null, tag ? "RESOLVED" : "PARTIAL", now, mappingKey, position]
					};
				}),
				{
					sql: "DELETE FROM label_bindings WHERE mapping_key = ? AND state = 'STALE_GITHUB'",
					args: [mappingKey]
				}
			],
			"write"
		);
		const skipped = activeRows.length - plan.resolutions.length;
		this.#logger.info("Synchronized automatic Discord forum tags.", {
			mapped: plan.resolutions.length,
			mappingKey,
			removed: staleTagIds.size,
			skipped
		});
		if (skipped > 0) {
			this.#logger.warn("Some GitHub labels could not receive Discord tags because the forum tag capacity was reached.", {
				mappingKey,
				skipped
			});
		}
	}

	public async forumTagNames(mappingKey: string) {
		const channel = await this.validateForum(mappingKey);
		return channel.available_tags.map((tag) => tag.name);
	}

	public async bootstrapThreads(mappingKey: string, activeOnly: boolean): Promise<JsonObject[]> {
		const mapping = this.#mapping(mappingKey);
		const active = await this.#client.api.guilds.getActiveThreads(this.#config.guildId);
		const threads: APIThreadChannel<ChannelType.PublicThread>[] = [];
		for (const thread of active.threads) {
			if (thread.type === ChannelType.PublicThread && thread.parent_id === mapping.forumChannelId) {
				threads.push(thread);
			}
		}

		if (!activeOnly) {
			let before: string | undefined;
			for (;;) {
				const archived = await this.#client.api.channels.getArchivedThreads(mapping.forumChannelId, "public", {
					before,
					limit: 100
				});
				let lastArchiveTimestamp: string | undefined;
				for (const thread of archived.threads) {
					if (thread.type === ChannelType.PublicThread && !threads.some((candidate) => candidate.id === thread.id)) {
						threads.push(thread);
					}
					if (thread.type === ChannelType.PublicThread) {
						lastArchiveTimestamp = thread.thread_metadata?.archive_timestamp;
					}
				}
				if (!archived.has_more) {
					break;
				}
				before = lastArchiveTimestamp;
				if (!before) {
					break;
				}
			}
		}

		return threads.sort((left, right) => Number(BigInt(left.id) - BigInt(right.id))).map((thread) => jsonObject(thread));
	}

	public async bootstrapMessages(threadId: string) {
		const messages = [];
		let before: string | undefined;
		for (;;) {
			const page = await this.#client.api.channels.getMessages(threadId, { before, limit: 100 });
			messages.push(...page);
			if (page.length < 100) {
				break;
			}
			before = page.at(-1)?.id;
			if (!before) {
				break;
			}
		}
		return messages.sort((left, right) => Number(BigInt(left.id) - BigInt(right.id))).map((message) => jsonObject(message));
	}

	public async createThread(
		mappingKey: string,
		name: string,
		payload: DiscordRenderPayload,
		appliedTagIds: readonly string[] = []
	) {
		const webhook = await this.ensureWebhook(mappingKey);
		try {
			const message = await this.#client.api.webhooks.execute(webhook.id, webhook.token, {
				...webhookMessageBody(payload),
				applied_tags: [...appliedTagIds],
				thread_name: name,
				wait: true,
				with_components: true
			});
			return { messageId: message.id, threadId: message.channel_id };
		} catch (error) {
			throw classifyDiscordError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async createMessage(mappingKey: string, threadId: string, payload: DiscordRenderPayload) {
		const webhook = await this.ensureWebhook(mappingKey);
		try {
			const message = await this.#client.api.webhooks.execute(webhook.id, webhook.token, {
				...webhookMessageBody(payload),
				thread_id: threadId,
				wait: true,
				with_components: true
			});
			return { messageId: message.id };
		} catch (error) {
			throw classifyDiscordError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async editMessage(mappingKey: string, threadId: string, messageId: string, payload: DiscordRenderPayload) {
		const webhook = await this.ensureWebhook(mappingKey);
		try {
			const message = await this.#client.api.webhooks.editMessage(webhook.id, webhook.token, messageId, {
				allowed_mentions: { parse: [] },
				attachments: [],
				components: payload.components,
				files: payload.files,
				thread_id: threadId,
				with_components: true
			});
			return { messageId: message.id };
		} catch (error) {
			throw classifyDiscordError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async deleteMessage(mappingKey: string, threadId: string, messageId: string) {
		const webhook = await this.ensureWebhook(mappingKey);
		try {
			await this.#client.api.webhooks.deleteMessage(webhook.id, webhook.token, messageId, { thread_id: threadId });
			return { messageId };
		} catch (error) {
			throw classifyDiscordError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async editThread(
		threadId: string,
		changes: { appliedTagIds?: readonly string[]; archived?: boolean; locked?: boolean; name?: string }
	) {
		try {
			const channel = await this.#client.api.channels.edit(threadId, {
				applied_tags: changes.appliedTagIds ? [...changes.appliedTagIds] : undefined,
				archived: changes.archived,
				locked: changes.locked,
				name: changes.name
			});
			return { threadId: channel.id };
		} catch (error) {
			throw classifyDiscordError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async fetchMessage(threadId: string, messageId: string) {
		try {
			return await this.#client.api.channels.getMessage(threadId, messageId);
		} catch (error) {
			throw classifyDiscordError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async recentThreadAuditLog() {
		const result = await this.#client.api.guilds.getAuditLogs(this.#config.guildId, {
			action_type: AuditLogEvent.ThreadUpdate,
			limit: 50
		});
		return jsonObject(result);
	}

	public webhookId(mappingKey: string) {
		return this.#webhooks.get(mappingKey)?.id;
	}

	#mapping(mappingKey: string) {
		const mapping = this.#config.mappings[mappingKey];
		if (!mapping) {
			throw new RelayFailure(`Mapping "${mappingKey}" is not configured.`, "invalid", "MAPPING_NOT_FOUND");
		}
		return mapping;
	}

	async #markMappingFailure(mappingKey: string, message: string) {
		await this.#database.execute({
			sql: `
				UPDATE mappings SET state = 'DEGRADED', last_error_code = 'DISCORD_VALIDATION',
					last_error_message = ?, updated_at = ? WHERE key = ?
			`,
			args: [message, Date.now(), mappingKey]
		});
	}
}

function classifyDiscordError(error: Error) {
	const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
	const rawCode = "code" in error ? error.code : undefined;
	const code =
		typeof rawCode === "number" ? rawCode : typeof rawCode === "string" && /^\d+$/.test(rawCode) ? Number(rawCode) : undefined;
	const retryAfter = "retry_after" in error && typeof error.retry_after === "number" ? error.retry_after * 1_000 : undefined;

	if (code === 30_007) {
		return new RelayFailure(
			"Discord's webhook limit is full and no reusable Forum Relay webhook was found. Delete one unused webhook from the mapped forum, then restart Forum Relay.",
			"invalid",
			"DISCORD_WEBHOOK_LIMIT"
		);
	}
	if (status === 401 || status === 403) {
		return new RelayFailure(error.message, "authentication", `DISCORD_${status}`);
	}
	if (status === 404) {
		return new RelayFailure(error.message, "not-found", "DISCORD_404");
	}
	if (status === 400) {
		return new RelayFailure(error.message, "invalid", "DISCORD_400");
	}
	if (status === 429 || retryAfter !== undefined) {
		return new RelayFailure(error.message, "rate-limit", "DISCORD_RATE_LIMIT", retryAfter);
	}
	return new RelayFailure(error.message, "temporary", status ? `DISCORD_${status}` : "DISCORD_NETWORK");
}

function jsonObject(value: object): JsonObject {
	const result: JsonValue = JSON.parse(JSON.stringify(value));
	if (!result || Array.isArray(result) || typeof result !== "object") {
		throw new Error("Expected serialized Discord data to be an object.");
	}
	return result;
}
