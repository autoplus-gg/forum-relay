import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
};

export const appMetaTable = sqliteTable("app_meta", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const workerLeasesTable = sqliteTable("worker_leases", {
	name: text("name").primaryKey(),
	instanceId: text("instance_id").notNull(),
	hostLabel: text("host_label").notNull(),
	acquiredAt: integer("acquired_at", { mode: "timestamp_ms" }).notNull(),
	renewedAt: integer("renewed_at", { mode: "timestamp_ms" }).notNull(),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull()
});

export const mappingsTable = sqliteTable(
	"mappings",
	{
		key: text("key").primaryKey(),
		guildId: text("guild_id").notNull(),
		forumChannelId: text("forum_channel_id").notNull(),
		githubOwner: text("github_owner").notNull(),
		githubRepository: text("github_repository").notNull(),
		githubRepositoryId: integer("github_repository_id"),
		githubInstallationId: integer("github_installation_id"),
		state: text("state").notNull(),
		configFingerprint: text("config_fingerprint").notNull(),
		bootstrapCompletedAt: integer("bootstrap_completed_at", { mode: "timestamp_ms" }),
		disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
		lastErrorCode: text("last_error_code"),
		lastErrorMessage: text("last_error_message"),
		...timestamps
	},
	(table) => [
		uniqueIndex("mappings_forum_channel_unique").on(table.forumChannelId),
		uniqueIndex("mappings_repository_id_unique").on(table.githubRepositoryId),
		index("mappings_state_index").on(table.state)
	]
);

export const mappingWebhooksTable = sqliteTable("mapping_webhooks", {
	mappingKey: text("mapping_key")
		.primaryKey()
		.references(() => mappingsTable.key, { onDelete: "restrict" }),
	webhookId: text("webhook_id").notNull().unique(),
	webhookToken: text("webhook_token").notNull(),
	applicationId: text("application_id").notNull(),
	channelId: text("channel_id").notNull(),
	...timestamps
});

export const mappingCursorsTable = sqliteTable(
	"mapping_cursors",
	{
		mappingKey: text("mapping_key")
			.notNull()
			.references(() => mappingsTable.key, { onDelete: "restrict" }),
		kind: text("kind").notNull(),
		value: text("value").notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
	},
	(table) => [uniqueIndex("mapping_cursors_mapping_kind_unique").on(table.mappingKey, table.kind)]
);

export const labelBindingsTable = sqliteTable(
	"label_bindings",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		mappingKey: text("mapping_key")
			.notNull()
			.references(() => mappingsTable.key, { onDelete: "restrict" }),
		position: integer("position").notNull(),
		configuredGithubName: text("configured_github_name").notNull(),
		configuredDiscordName: text("configured_discord_name").notNull(),
		githubLabelId: integer("github_label_id"),
		githubCurrentName: text("github_current_name"),
		discordTagId: text("discord_tag_id"),
		discordCurrentName: text("discord_current_name"),
		state: text("state").notNull(),
		...timestamps
	},
	(table) => [
		uniqueIndex("label_bindings_mapping_position_unique").on(table.mappingKey, table.position),
		uniqueIndex("label_bindings_github_id_unique").on(table.mappingKey, table.githubLabelId),
		uniqueIndex("label_bindings_discord_id_unique").on(table.mappingKey, table.discordTagId)
	]
);

export const issueThreadLinksTable = sqliteTable(
	"issue_thread_links",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		mappingKey: text("mapping_key")
			.notNull()
			.references(() => mappingsTable.key, { onDelete: "restrict" }),
		githubIssueId: integer("github_issue_id").notNull(),
		githubIssueNodeId: text("github_issue_node_id").notNull(),
		githubIssueNumber: integer("github_issue_number").notNull(),
		discordThreadId: text("discord_thread_id"),
		previousDiscordThreadIdsJson: text("previous_discord_thread_ids_json").notNull().default("[]"),
		fullTitle: text("full_title").notNull(),
		state: text("state").notNull(),
		locked: integer("locked", { mode: "boolean" }).notNull().default(false),
		status: text("status").notNull(),
		...timestamps
	},
	(table) => [
		uniqueIndex("issue_thread_links_github_issue_unique").on(table.mappingKey, table.githubIssueId),
		uniqueIndex("issue_thread_links_discord_thread_unique").on(table.mappingKey, table.discordThreadId),
		index("issue_thread_links_mapping_state_index").on(table.mappingKey, table.state)
	]
);

export const relayItemsTable = sqliteTable(
	"relay_items",
	{
		id: text("id").primaryKey(),
		mappingKey: text("mapping_key")
			.notNull()
			.references(() => mappingsTable.key, { onDelete: "restrict" }),
		issueThreadLinkId: integer("issue_thread_link_id")
			.notNull()
			.references(() => issueThreadLinksTable.id, { onDelete: "restrict" }),
		sourcePlatform: text("source_platform").notNull(),
		sourceKind: text("source_kind").notNull(),
		sourceId: text("source_id").notNull(),
		destinationPlatform: text("destination_platform").notNull(),
		destinationKind: text("destination_kind").notNull(),
		destinationId: text("destination_id"),
		parentSourceId: text("parent_source_id"),
		sourceBody: text("source_body").notNull().default(""),
		sourceRevision: text("source_revision").notNull(),
		sourceHash: text("source_hash").notNull(),
		canonicalHash: text("canonical_hash").notNull(),
		renderHash: text("render_hash"),
		renderVersion: integer("render_version").notNull().default(1),
		authorId: text("author_id").notNull(),
		authorUsername: text("author_username").notNull(),
		authorDisplayName: text("author_display_name").notNull(),
		authorAvatarUrl: text("author_avatar_url"),
		state: text("state").notNull(),
		suppressedAt: integer("suppressed_at", { mode: "timestamp_ms" }),
		deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
		minimizedReason: text("minimized_reason"),
		...timestamps
	},
	(table) => [
		uniqueIndex("relay_items_source_unique").on(table.mappingKey, table.sourcePlatform, table.sourceKind, table.sourceId),
		uniqueIndex("relay_items_destination_unique").on(
			table.mappingKey,
			table.destinationPlatform,
			table.destinationKind,
			table.destinationId
		),
		index("relay_items_link_index").on(table.issueThreadLinkId)
	]
);

export const relaySegmentsTable = sqliteTable(
	"relay_segments",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		relayItemId: text("relay_item_id")
			.notNull()
			.references(() => relayItemsTable.id, { onDelete: "restrict" }),
		position: integer("position").notNull(),
		discordMessageId: text("discord_message_id").notNull(),
		renderHash: text("render_hash").notNull(),
		...timestamps
	},
	(table) => [
		uniqueIndex("relay_segments_item_position_unique").on(table.relayItemId, table.position),
		uniqueIndex("relay_segments_message_unique").on(table.discordMessageId)
	]
);

export const revisionShadowsTable = sqliteTable("revision_shadows", {
	relayItemId: text("relay_item_id")
		.primaryKey()
		.references(() => relayItemsTable.id, { onDelete: "restrict" }),
	discordMessageId: text("discord_message_id").notNull().unique(),
	canonicalHash: text("canonical_hash").notNull(),
	...timestamps
});

export const attachmentLinksTable = sqliteTable(
	"attachment_links",
	{
		id: text("id").primaryKey(),
		relayItemId: text("relay_item_id")
			.notNull()
			.references(() => relayItemsTable.id, { onDelete: "restrict" }),
		sourcePlatform: text("source_platform").notNull(),
		sourceAttachmentId: text("source_attachment_id").notNull(),
		sourceUrl: text("source_url").notNull(),
		filename: text("filename").notNull(),
		contentType: text("content_type"),
		size: integer("size"),
		proxyHash: text("proxy_hash"),
		proxyUrl: text("proxy_url"),
		state: text("state").notNull(),
		lastErrorCode: text("last_error_code"),
		...timestamps
	},
	(table) => [
		uniqueIndex("attachment_links_source_unique").on(table.sourcePlatform, table.sourceAttachmentId),
		index("attachment_links_item_index").on(table.relayItemId)
	]
);

export const inboxEventsTable = sqliteTable(
	"inbox_events",
	{
		id: text("id").primaryKey(),
		idempotencyKey: text("idempotency_key").notNull().unique(),
		platform: text("platform").notNull(),
		eventKind: text("event_kind").notNull(),
		mappingKey: text("mapping_key").references(() => mappingsTable.key, { onDelete: "restrict" }),
		partitionKey: text("partition_key"),
		payloadJson: text("payload_json").notNull(),
		state: text("state").notNull(),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
		claimOwner: text("claim_owner"),
		claimExpiresAt: integer("claim_expires_at", { mode: "timestamp_ms" }),
		lastErrorCode: text("last_error_code"),
		lastErrorMessage: text("last_error_message"),
		correlationId: text("correlation_id").notNull(),
		processedAt: integer("processed_at", { mode: "timestamp_ms" }),
		redactedAt: integer("redacted_at", { mode: "timestamp_ms" }),
		...timestamps
	},
	(table) => [
		index("inbox_events_claim_index").on(table.state, table.nextAttemptAt, table.createdAt),
		index("inbox_events_partition_index").on(table.partitionKey, table.createdAt)
	]
);

export const outboxOperationsTable = sqliteTable(
	"outbox_operations",
	{
		id: text("id").primaryKey(),
		idempotencyKey: text("idempotency_key").notNull().unique(),
		platform: text("platform").notNull(),
		operationKind: text("operation_kind").notNull(),
		mappingKey: text("mapping_key")
			.notNull()
			.references(() => mappingsTable.key, { onDelete: "restrict" }),
		partitionKey: text("partition_key").notNull(),
		relayItemId: text("relay_item_id").references(() => relayItemsTable.id, { onDelete: "restrict" }),
		expectedSourceRevision: text("expected_source_revision"),
		payloadJson: text("payload_json").notNull(),
		resultJson: text("result_json"),
		state: text("state").notNull(),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
		claimOwner: text("claim_owner"),
		claimExpiresAt: integer("claim_expires_at", { mode: "timestamp_ms" }),
		lastErrorCode: text("last_error_code"),
		lastErrorMessage: text("last_error_message"),
		correlationId: text("correlation_id").notNull(),
		completedAt: integer("completed_at", { mode: "timestamp_ms" }),
		redactedAt: integer("redacted_at", { mode: "timestamp_ms" }),
		...timestamps
	},
	(table) => [
		index("outbox_operations_claim_index").on(table.state, table.nextAttemptAt, table.createdAt),
		index("outbox_operations_partition_index").on(table.partitionKey, table.createdAt)
	]
);

export const operationDependenciesTable = sqliteTable(
	"operation_dependencies",
	{
		operationId: text("operation_id")
			.notNull()
			.references(() => outboxOperationsTable.id, { onDelete: "restrict" }),
		dependsOnOperationId: text("depends_on_operation_id")
			.notNull()
			.references(() => outboxOperationsTable.id, { onDelete: "restrict" })
	},
	(table) => [uniqueIndex("operation_dependencies_unique").on(table.operationId, table.dependsOnOperationId)]
);

export const operationLedgerTable = sqliteTable(
	"operation_ledger",
	{
		id: text("id").primaryKey(),
		outboxOperationId: text("outbox_operation_id").references(() => outboxOperationsTable.id, {
			onDelete: "restrict"
		}),
		platform: text("platform").notNull(),
		resourceType: text("resource_type").notNull(),
		resourceId: text("resource_id").notNull(),
		action: text("action").notNull(),
		expectedStateHash: text("expected_state_hash"),
		matchedEventId: text("matched_event_id"),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		...timestamps
	},
	(table) => [
		index("operation_ledger_match_index").on(table.platform, table.resourceType, table.resourceId, table.action, table.expiresAt)
	]
);

export const bootstrapJobsTable = sqliteTable("bootstrap_jobs", {
	id: text("id").primaryKey(),
	mappingKey: text("mapping_key")
		.notNull()
		.references(() => mappingsTable.key, { onDelete: "restrict" }),
	state: text("state").notNull(),
	sourcePlatform: text("source_platform").notNull(),
	previewDigest: text("preview_digest").notNull(),
	previewJson: text("preview_json").notNull(),
	cursorJson: text("cursor_json"),
	snapshotHighWatermark: text("snapshot_high_watermark"),
	startedByDiscordUserId: text("started_by_discord_user_id"),
	startedAt: integer("started_at", { mode: "timestamp_ms" }),
	completedAt: integer("completed_at", { mode: "timestamp_ms" }),
	...timestamps
});

export const reconciliationRunsTable = sqliteTable("reconciliation_runs", {
	id: text("id").primaryKey(),
	mappingKey: text("mapping_key")
		.notNull()
		.references(() => mappingsTable.key, { onDelete: "restrict" }),
	kind: text("kind").notNull(),
	state: text("state").notNull(),
	planJson: text("plan_json"),
	startedByDiscordUserId: text("started_by_discord_user_id"),
	startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
	completedAt: integer("completed_at", { mode: "timestamp_ms" }),
	...timestamps
});

export const auditClassificationJobsTable = sqliteTable(
	"audit_classification_jobs",
	{
		id: text("id").primaryKey(),
		mappingKey: text("mapping_key")
			.notNull()
			.references(() => mappingsTable.key, { onDelete: "restrict" }),
		threadId: text("thread_id").notNull(),
		previousStateJson: text("previous_state_json").notNull(),
		observedStateJson: text("observed_state_json").notNull(),
		observedAt: integer("observed_at", { mode: "timestamp_ms" }).notNull(),
		state: text("state").notNull(),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
		classification: text("classification"),
		evidenceJson: text("evidence_json"),
		...timestamps
	},
	(table) => [index("audit_classification_claim_index").on(table.state, table.nextAttemptAt)]
);

export const maintenanceRunsTable = sqliteTable("maintenance_runs", {
	id: text("id").primaryKey(),
	kind: text("kind").notNull(),
	state: text("state").notNull(),
	detailsJson: text("details_json"),
	startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
	completedAt: integer("completed_at", { mode: "timestamp_ms" }),
	...timestamps
});

export const backupRecordsTable = sqliteTable("backup_records", {
	id: text("id").primaryKey(),
	path: text("path").notNull().unique(),
	reason: text("reason").notNull(),
	schemaVersion: text("schema_version").notNull(),
	size: integer("size").notNull(),
	verifiedAt: integer("verified_at", { mode: "timestamp_ms" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export type AppMetaRecord = typeof appMetaTable.$inferSelect;
export type MappingRecord = typeof mappingsTable.$inferSelect;
export type IssueThreadLinkRecord = typeof issueThreadLinksTable.$inferSelect;
export type RelayItemRecord = typeof relayItemsTable.$inferSelect;
export type InboxEventRecord = typeof inboxEventsTable.$inferSelect;
export type OutboxOperationRecord = typeof outboxOperationsTable.$inferSelect;
