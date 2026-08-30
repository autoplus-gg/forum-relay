import { createHash } from "node:crypto";
import type { Client, Row } from "@libsql/client";

export interface GitHubIssueIdentity {
	id: number;
	locked: boolean;
	nodeId: string;
	number: number;
	state: "closed" | "open";
	title: string;
}

export interface IssueThreadLink {
	discordThreadId?: string;
	fullTitle: string;
	githubIssueId: number;
	githubIssueNodeId: string;
	githubIssueNumber: number;
	id: number;
	locked: boolean;
	mappingKey: string;
	state: "closed" | "open";
	status: string;
}

export interface RelayAuthor {
	avatarUrl?: string;
	displayName: string;
	id: string;
	username: string;
}

export interface UpsertRelayItem {
	author: RelayAuthor;
	destinationKind: string;
	destinationPlatform: "discord" | "github";
	issueThreadLinkId: number;
	mappingKey: string;
	parentSourceId?: string;
	sourceBody: string;
	sourceId: string;
	sourceKind: string;
	sourcePlatform: "discord" | "github";
	sourceRevision: string;
}

export interface RelayItem {
	author: RelayAuthor;
	destinationId?: string;
	destinationKind: string;
	destinationPlatform: "discord" | "github";
	id: string;
	issueThreadLinkId: number;
	mappingKey: string;
	renderHash?: string;
	sourceBody: string;
	sourceId: string;
	sourceKind: string;
	sourcePlatform: "discord" | "github";
	state: string;
}

export interface StoredAttachment {
	contentType?: string;
	filename: string;
	id: string;
	proxyHash?: string;
	proxyUrl?: string;
	size?: number;
	sourceAttachmentId: string;
	sourceUrl: string;
	state: string;
}

export class RelayRepository {
	public constructor(private readonly client: Client) {}

	public async ensureGitHubIssueLink(mappingKey: string, issue: GitHubIssueIdentity) {
		const existing = await this.findLinkByGitHub(mappingKey, issue.id);
		if (existing) {
			await this.client.execute({
				sql: `
					UPDATE issue_thread_links SET full_title = ?, state = ?, locked = ?, updated_at = ?
					WHERE id = ?
				`,
				args: [issue.title, issue.state, issue.locked, Date.now(), existing.id]
			});
			return { ...existing, fullTitle: issue.title, locked: issue.locked, state: issue.state };
		}

		const now = Date.now();
		const result = await this.client.execute({
			sql: `
				INSERT INTO issue_thread_links (
					mapping_key, github_issue_id, github_issue_node_id, github_issue_number,
					full_title, state, locked, status, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
				RETURNING *
			`,
			args: [mappingKey, issue.id, issue.nodeId, issue.number, issue.title, issue.state, issue.locked, now, now]
		});
		return toLink(requiredRow(result.rows[0], "created issue/thread link"));
	}

	public async createDiscordOriginLink(
		mappingKey: string,
		threadId: string,
		title: string,
		issue: Omit<GitHubIssueIdentity, "locked" | "state">
	) {
		const existing = await this.findLinkByDiscord(mappingKey, threadId);
		if (existing) {
			return existing;
		}
		const now = Date.now();
		const result = await this.client.execute({
			sql: `
				INSERT INTO issue_thread_links (
					mapping_key, github_issue_id, github_issue_node_id, github_issue_number,
					discord_thread_id, full_title, state, locked, status, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, 'open', 0, 'ACTIVE', ?, ?)
				RETURNING *
			`,
			args: [mappingKey, issue.id, issue.nodeId, issue.number, threadId, title, now, now]
		});
		return toLink(requiredRow(result.rows[0], "Discord-origin issue/thread link"));
	}

	public async attachDiscordThread(linkId: number, threadId: string) {
		await this.client.execute({
			sql: "UPDATE issue_thread_links SET discord_thread_id = ?, updated_at = ? WHERE id = ?",
			args: [threadId, Date.now(), linkId]
		});
	}

	public async findLinkByGitHub(mappingKey: string, issueId: number) {
		const result = await this.client.execute({
			sql: "SELECT * FROM issue_thread_links WHERE mapping_key = ? AND github_issue_id = ?",
			args: [mappingKey, issueId]
		});
		return result.rows[0] ? toLink(result.rows[0]) : undefined;
	}

	public async findLinkByDiscord(mappingKey: string, threadId: string) {
		const result = await this.client.execute({
			sql: "SELECT * FROM issue_thread_links WHERE mapping_key = ? AND discord_thread_id = ?",
			args: [mappingKey, threadId]
		});
		return result.rows[0] ? toLink(result.rows[0]) : undefined;
	}

	public async findLinkByGitHubNumber(mappingKey: string, issueNumber: number) {
		const result = await this.client.execute({
			sql: "SELECT * FROM issue_thread_links WHERE mapping_key = ? AND github_issue_number = ?",
			args: [mappingKey, issueNumber]
		});
		return result.rows[0] ? toLink(result.rows[0]) : undefined;
	}

	public async findLinkByGitHubNode(nodeId: string) {
		const result = await this.client.execute({
			sql: "SELECT * FROM issue_thread_links WHERE github_issue_node_id = ?",
			args: [nodeId]
		});
		return result.rows[0] ? toLink(result.rows[0]) : undefined;
	}

	public async getLink(id: number) {
		const result = await this.client.execute({ sql: "SELECT * FROM issue_thread_links WHERE id = ?", args: [id] });
		return result.rows[0] ? toLink(result.rows[0]) : undefined;
	}

	public async upsertRelayItem(input: UpsertRelayItem) {
		const now = Date.now();
		const sourceHash = hash(input.sourceBody);
		const existing = await this.findRelayItem(input.mappingKey, input.sourcePlatform, input.sourceKind, input.sourceId);
		if (existing) {
			await this.client.execute({
				sql: `
					UPDATE relay_items SET source_body = ?, source_revision = ?, source_hash = ?,
						canonical_hash = ?, author_id = ?, author_username = ?, author_display_name = ?,
						author_avatar_url = ?, state = 'ACTIVE', deleted_at = NULL, updated_at = ?
					WHERE id = ?
				`,
				args: [
					input.sourceBody,
					input.sourceRevision,
					sourceHash,
					sourceHash,
					input.author.id,
					input.author.username,
					input.author.displayName,
					input.author.avatarUrl ?? null,
					now,
					existing.id
				]
			});
			return { ...existing, sourceBody: input.sourceBody, state: "ACTIVE" };
		}

		const id = crypto.randomUUID();
		await this.client.execute({
			sql: `
				INSERT INTO relay_items (
					id, mapping_key, issue_thread_link_id, source_platform, source_kind, source_id,
					destination_platform, destination_kind, parent_source_id, source_body, source_revision,
					source_hash, canonical_hash, author_id, author_username, author_display_name,
					author_avatar_url, state, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
			`,
			args: [
				id,
				input.mappingKey,
				input.issueThreadLinkId,
				input.sourcePlatform,
				input.sourceKind,
				input.sourceId,
				input.destinationPlatform,
				input.destinationKind,
				input.parentSourceId ?? null,
				input.sourceBody,
				input.sourceRevision,
				sourceHash,
				sourceHash,
				input.author.id,
				input.author.username,
				input.author.displayName,
				input.author.avatarUrl ?? null,
				now,
				now
			]
		});
		return {
			author: input.author,
			destinationKind: input.destinationKind,
			destinationPlatform: input.destinationPlatform,
			id,
			issueThreadLinkId: input.issueThreadLinkId,
			mappingKey: input.mappingKey,
			renderHash: undefined,
			sourceBody: input.sourceBody,
			sourceId: input.sourceId,
			sourceKind: input.sourceKind,
			sourcePlatform: input.sourcePlatform,
			state: "ACTIVE"
		} satisfies RelayItem;
	}

	public async findRelayItem(mappingKey: string, platform: string, kind: string, sourceId: string) {
		const result = await this.client.execute({
			sql: `
				SELECT * FROM relay_items
				WHERE mapping_key = ? AND source_platform = ? AND source_kind = ? AND source_id = ?
			`,
			args: [mappingKey, platform, kind, sourceId]
		});
		return result.rows[0] ? toRelayItem(result.rows[0]) : undefined;
	}

	public async findRelayItemByDestination(mappingKey: string, platform: string, kind: string, destinationId: string) {
		const result = await this.client.execute({
			sql: `
				SELECT * FROM relay_items
				WHERE mapping_key = ? AND destination_platform = ? AND destination_kind = ? AND destination_id = ?
			`,
			args: [mappingKey, platform, kind, destinationId]
		});
		return result.rows[0] ? toRelayItem(result.rows[0]) : undefined;
	}

	public async getRelayItem(id: string) {
		const result = await this.client.execute({ sql: "SELECT * FROM relay_items WHERE id = ?", args: [id] });
		return result.rows[0] ? toRelayItem(result.rows[0]) : undefined;
	}

	public async setDestination(relayItemId: string, destinationId: string) {
		await this.client.execute({
			sql: "UPDATE relay_items SET destination_id = ?, updated_at = ? WHERE id = ?",
			args: [destinationId, Date.now(), relayItemId]
		});
	}

	public async setRenderHash(relayItemId: string, renderHash: string) {
		await this.client.execute({
			sql: "UPDATE relay_items SET render_hash = ?, updated_at = ? WHERE id = ?",
			args: [renderHash, Date.now(), relayItemId]
		});
	}

	public async saveRevisionShadow(relayItemId: string, discordMessageId: string, canonicalHash: string) {
		const now = Date.now();
		await this.client.execute({
			sql: `
				INSERT INTO revision_shadows (
					relay_item_id, discord_message_id, canonical_hash, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(relay_item_id) DO UPDATE SET
					discord_message_id = excluded.discord_message_id,
					canonical_hash = excluded.canonical_hash,
					updated_at = excluded.updated_at
			`,
			args: [relayItemId, discordMessageId, canonicalHash, now, now]
		});
	}

	public async replaceSegments(relayItemId: string, messageIds: readonly string[], renderHashes: readonly string[]) {
		const transaction = await this.client.transaction("write");
		try {
			await transaction.execute({ sql: "DELETE FROM relay_segments WHERE relay_item_id = ?", args: [relayItemId] });
			const now = Date.now();
			for (const [position, messageId] of messageIds.entries()) {
				await transaction.execute({
					sql: `
						INSERT INTO relay_segments (
							relay_item_id, position, discord_message_id, render_hash, created_at, updated_at
						) VALUES (?, ?, ?, ?, ?, ?)
					`,
					args: [relayItemId, position, messageId, renderHashes[position] ?? "", now, now]
				});
			}
			await transaction.commit();
		} catch (error) {
			await transaction.rollback();
			throw error;
		}
	}

	public async getSegments(relayItemId: string) {
		const result = await this.client.execute({
			sql: "SELECT discord_message_id, render_hash FROM relay_segments WHERE relay_item_id = ? ORDER BY position",
			args: [relayItemId]
		});
		return result.rows.map((row) => ({
			messageId: String(row.discord_message_id),
			renderHash: String(row.render_hash)
		}));
	}

	public async markDeleted(relayItemId: string) {
		const transaction = await this.client.transaction("write");
		try {
			const now = Date.now();
			await transaction.execute({
				sql: `
					UPDATE relay_items
					SET state = 'DELETED', destination_id = NULL, render_hash = NULL,
						deleted_at = ?, updated_at = ?
					WHERE id = ?
				`,
				args: [now, now, relayItemId]
			});
			// A later edit can revive this source item. Its deleted Discord message
			// IDs must not then be mistaken for editable live segments.
			await transaction.execute({ sql: "DELETE FROM relay_segments WHERE relay_item_id = ?", args: [relayItemId] });
			await transaction.commit();
		} catch (error) {
			await transaction.rollback();
			throw error;
		}
	}

	public async updateLinkState(linkId: number, state: "closed" | "open", locked: boolean) {
		await this.client.execute({
			sql: "UPDATE issue_thread_links SET state = ?, locked = ?, updated_at = ? WHERE id = ?",
			args: [state, locked, Date.now(), linkId]
		});
	}

	public async updateLinkTitle(linkId: number, title: string) {
		await this.client.execute({
			sql: "UPDATE issue_thread_links SET full_title = ?, updated_at = ? WHERE id = ?",
			args: [title, Date.now(), linkId]
		});
	}

	public async linksForMapping(mappingKey: string) {
		const result = await this.client.execute({
			sql: "SELECT * FROM issue_thread_links WHERE mapping_key = ? ORDER BY github_issue_number",
			args: [mappingKey]
		});
		return result.rows.map(toLink);
	}

	public async markLinkStatus(linkId: number, status: string) {
		await this.client.execute({
			sql: "UPDATE issue_thread_links SET status = ?, updated_at = ? WHERE id = ?",
			args: [status, Date.now(), linkId]
		});
	}

	public async upsertAttachment(
		relayItemId: string,
		attachment: {
			contentType?: string;
			filename: string;
			id: string;
			size?: number;
			url: string;
		}
	) {
		const now = Date.now();
		await this.client.execute({
			sql: `
				INSERT INTO attachment_links (
					id, relay_item_id, source_platform, source_attachment_id, source_url,
					filename, content_type, size, state, created_at, updated_at
				) VALUES (?, ?, 'discord', ?, ?, ?, ?, ?, 'PENDING', ?, ?)
				ON CONFLICT(source_platform, source_attachment_id) DO UPDATE SET
					source_url = excluded.source_url, filename = excluded.filename,
					content_type = excluded.content_type, size = excluded.size, updated_at = excluded.updated_at
			`,
			args: [
				crypto.randomUUID(),
				relayItemId,
				attachment.id,
				attachment.url,
				attachment.filename,
				attachment.contentType ?? null,
				attachment.size ?? null,
				now,
				now
			]
		});
	}

	public async attachments(relayItemId: string) {
		const result = await this.client.execute({
			sql: "SELECT * FROM attachment_links WHERE relay_item_id = ? ORDER BY created_at, id",
			args: [relayItemId]
		});
		return result.rows.map(toAttachment);
	}

	public async completeAttachment(attachmentId: string, hashValue: string, url: string) {
		await this.client.execute({
			sql: `
				UPDATE attachment_links SET state = 'COMPLETE', proxy_hash = ?, proxy_url = ?,
					last_error_code = NULL, updated_at = ? WHERE id = ?
			`,
			args: [hashValue, url, Date.now(), attachmentId]
		});
	}

	public async failAttachment(attachmentId: string, code: string) {
		await this.client.execute({
			sql: "UPDATE attachment_links SET state = 'FAILED', last_error_code = ?, updated_at = ? WHERE id = ?",
			args: [code, Date.now(), attachmentId]
		});
	}

	public async githubLabelsForTags(mappingKey: string, tagIds: readonly string[]) {
		if (tagIds.length === 0) {
			return [];
		}
		const placeholders = tagIds.map(() => "?").join(", ");
		const result = await this.client.execute({
			sql: `
				SELECT configured_github_name FROM label_bindings
				WHERE mapping_key = ? AND discord_tag_id IN (${placeholders})
				ORDER BY position
			`,
			args: [mappingKey, ...tagIds]
		});
		return result.rows.map((row) => String(row.configured_github_name));
	}

	public async discordTagsForLabels(mappingKey: string, labelNames: readonly string[]) {
		const normalized = new Set(labelNames.map((name) => name.toLocaleLowerCase("en-US")));
		const result = await this.client.execute({
			sql: `
				SELECT configured_github_name, discord_tag_id FROM label_bindings
				WHERE mapping_key = ? AND discord_tag_id IS NOT NULL ORDER BY position
			`,
			args: [mappingKey]
		});
		return result.rows
			.filter((row) => normalized.has(String(row.configured_github_name).toLocaleLowerCase("en-US")))
			.map((row) => String(row.discord_tag_id))
			.slice(0, 5);
	}

	public async enqueueAuditClassification(mappingKey: string, threadId: string, observedState: string, observedAt: number) {
		await this.client.execute({
			sql: `
				INSERT INTO audit_classification_jobs (
					id, mapping_key, thread_id, previous_state_json, observed_state_json,
					observed_at, state, attempt_count, next_attempt_at, created_at, updated_at
				) VALUES (?, ?, ?, '{}', ?, ?, 'PENDING', 0, ?, ?, ?)
			`,
			args: [crypto.randomUUID(), mappingKey, threadId, observedState, observedAt, observedAt + 2_000, observedAt, observedAt]
		});
	}
}

function toLink(row: Row): IssueThreadLink {
	const state = String(row.state);
	if (state !== "open" && state !== "closed") {
		throw new Error(`Invalid issue state ${state}.`);
	}
	return {
		discordThreadId: typeof row.discord_thread_id === "string" ? row.discord_thread_id : undefined,
		fullTitle: String(row.full_title),
		githubIssueId: Number(row.github_issue_id),
		githubIssueNodeId: String(row.github_issue_node_id),
		githubIssueNumber: Number(row.github_issue_number),
		id: Number(row.id),
		locked: Boolean(row.locked),
		mappingKey: String(row.mapping_key),
		state,
		status: String(row.status)
	};
}

function toRelayItem(row: Row): RelayItem {
	const sourcePlatform = String(row.source_platform);
	const destinationPlatform = String(row.destination_platform);
	if (
		(sourcePlatform !== "discord" && sourcePlatform !== "github") ||
		(destinationPlatform !== "discord" && destinationPlatform !== "github")
	) {
		throw new Error("Invalid relay item platform.");
	}
	return {
		author: {
			avatarUrl: typeof row.author_avatar_url === "string" ? row.author_avatar_url : undefined,
			displayName: String(row.author_display_name),
			id: String(row.author_id),
			username: String(row.author_username)
		},
		destinationId: typeof row.destination_id === "string" ? row.destination_id : undefined,
		destinationKind: String(row.destination_kind),
		destinationPlatform,
		id: String(row.id),
		issueThreadLinkId: Number(row.issue_thread_link_id),
		mappingKey: String(row.mapping_key),
		renderHash: typeof row.render_hash === "string" ? row.render_hash : undefined,
		sourceBody: String(row.source_body),
		sourceId: String(row.source_id),
		sourceKind: String(row.source_kind),
		sourcePlatform,
		state: String(row.state)
	};
}

function toAttachment(row: Row): StoredAttachment {
	return {
		contentType: typeof row.content_type === "string" ? row.content_type : undefined,
		filename: String(row.filename),
		id: String(row.id),
		proxyHash: typeof row.proxy_hash === "string" ? row.proxy_hash : undefined,
		proxyUrl: typeof row.proxy_url === "string" ? row.proxy_url : undefined,
		size: typeof row.size === "number" ? row.size : undefined,
		sourceAttachmentId: String(row.source_attachment_id),
		sourceUrl: String(row.source_url),
		state: String(row.state)
	};
}

function requiredRow(row: Row | undefined, label: string) {
	if (!row) {
		throw new Error(`Database did not return the ${label}.`);
	}
	return row;
}

export function hash(value: string) {
	return createHash("sha256").update(value).digest("hex");
}
