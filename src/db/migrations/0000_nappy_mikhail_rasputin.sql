CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `attachment_links` (
	`id` text PRIMARY KEY NOT NULL,
	`relay_item_id` text NOT NULL,
	`source_platform` text NOT NULL,
	`source_attachment_id` text NOT NULL,
	`source_url` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text,
	`size` integer,
	`proxy_hash` text,
	`proxy_url` text,
	`state` text NOT NULL,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`relay_item_id`) REFERENCES `relay_items`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_links_source_unique` ON `attachment_links` (`source_platform`,`source_attachment_id`);--> statement-breakpoint
CREATE INDEX `attachment_links_item_index` ON `attachment_links` (`relay_item_id`);--> statement-breakpoint
CREATE TABLE `audit_classification_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`mapping_key` text NOT NULL,
	`thread_id` text NOT NULL,
	`previous_state_json` text NOT NULL,
	`observed_state_json` text NOT NULL,
	`observed_at` integer NOT NULL,
	`state` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`classification` text,
	`evidence_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mapping_key`) REFERENCES `mappings`(`key`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `audit_classification_claim_index` ON `audit_classification_jobs` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `backup_records` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`reason` text NOT NULL,
	`schema_version` text NOT NULL,
	`size` integer NOT NULL,
	`verified_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_records_path_unique` ON `backup_records` (`path`);--> statement-breakpoint
CREATE TABLE `bootstrap_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`mapping_key` text NOT NULL,
	`state` text NOT NULL,
	`source_platform` text NOT NULL,
	`preview_digest` text NOT NULL,
	`preview_json` text NOT NULL,
	`cursor_json` text,
	`snapshot_high_watermark` text,
	`started_by_discord_user_id` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mapping_key`) REFERENCES `mappings`(`key`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `inbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`platform` text NOT NULL,
	`event_kind` text NOT NULL,
	`mapping_key` text,
	`partition_key` text,
	`payload_json` text NOT NULL,
	`state` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`claim_owner` text,
	`claim_expires_at` integer,
	`last_error_code` text,
	`last_error_message` text,
	`correlation_id` text NOT NULL,
	`processed_at` integer,
	`redacted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mapping_key`) REFERENCES `mappings`(`key`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_events_idempotency_key_unique` ON `inbox_events` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `inbox_events_claim_index` ON `inbox_events` (`state`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `inbox_events_partition_index` ON `inbox_events` (`partition_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `issue_thread_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mapping_key` text NOT NULL,
	`github_issue_id` integer NOT NULL,
	`github_issue_node_id` text NOT NULL,
	`github_issue_number` integer NOT NULL,
	`discord_thread_id` text,
	`previous_discord_thread_ids_json` text DEFAULT '[]' NOT NULL,
	`full_title` text NOT NULL,
	`state` text NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mapping_key`) REFERENCES `mappings`(`key`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_thread_links_github_issue_unique` ON `issue_thread_links` (`mapping_key`,`github_issue_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_thread_links_discord_thread_unique` ON `issue_thread_links` (`mapping_key`,`discord_thread_id`);--> statement-breakpoint
CREATE INDEX `issue_thread_links_mapping_state_index` ON `issue_thread_links` (`mapping_key`,`state`);--> statement-breakpoint
CREATE TABLE `label_bindings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mapping_key` text NOT NULL,
	`position` integer NOT NULL,
	`configured_github_name` text NOT NULL,
	`configured_discord_name` text NOT NULL,
	`github_label_id` integer,
	`github_current_name` text,
	`discord_tag_id` text,
	`discord_current_name` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mapping_key`) REFERENCES `mappings`(`key`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `label_bindings_mapping_position_unique` ON `label_bindings` (`mapping_key`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `label_bindings_github_id_unique` ON `label_bindings` (`mapping_key`,`github_label_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `label_bindings_discord_id_unique` ON `label_bindings` (`mapping_key`,`discord_tag_id`);--> statement-breakpoint
CREATE TABLE `maintenance_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`details_json` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mapping_cursors` (
	`mapping_key` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mapping_key`) REFERENCES `mappings`(`key`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mapping_cursors_mapping_kind_unique` ON `mapping_cursors` (`mapping_key`,`kind`);--> statement-breakpoint
CREATE TABLE `mapping_webhooks` (
	`mapping_key` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`webhook_token` text NOT NULL,
	`application_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mapping_key`) REFERENCES `mappings`(`key`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mapping_webhooks_webhook_id_unique` ON `mapping_webhooks` (`webhook_id`);--> statement-breakpoint
CREATE TABLE `mappings` (
	`key` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`forum_channel_id` text NOT NULL,
	`github_owner` text NOT NULL,
	`github_repository` text NOT NULL,
	`github_repository_id` integer,
	`github_installation_id` integer,
	`state` text NOT NULL,
	`config_fingerprint` text NOT NULL,
	`bootstrap_completed_at` integer,
	`disabled_at` integer,
	`last_error_code` text,
	`last_error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mappings_forum_channel_unique` ON `mappings` (`forum_channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mappings_repository_id_unique` ON `mappings` (`github_repository_id`);--> statement-breakpoint
CREATE INDEX `mappings_state_index` ON `mappings` (`state`);--> statement-breakpoint
CREATE TABLE `operation_dependencies` (
	`operation_id` text NOT NULL,
	`depends_on_operation_id` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `outbox_operations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`depends_on_operation_id`) REFERENCES `outbox_operations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operation_dependencies_unique` ON `operation_dependencies` (`operation_id`,`depends_on_operation_id`);--> statement-breakpoint
CREATE TABLE `operation_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`outbox_operation_id` text,
	`platform` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`action` text NOT NULL,
	`expected_state_hash` text,
	`matched_event_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`outbox_operation_id`) REFERENCES `outbox_operations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `operation_ledger_match_index` ON `operation_ledger` (`platform`,`resource_type`,`resource_id`,`action`,`expires_at`);--> statement-breakpoint
CREATE TABLE `outbox_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`platform` text NOT NULL,
	`operation_kind` text NOT NULL,
	`mapping_key` text NOT NULL,
	`partition_key` text NOT NULL,
	`relay_item_id` text,
	`expected_source_revision` text,
	`payload_json` text NOT NULL,
	`result_json` text,
	`state` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`claim_owner` text,
	`claim_expires_at` integer,
	`last_error_code` text,
	`last_error_message` text,
	`correlation_id` text NOT NULL,
	`completed_at` integer,
	`redacted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mapping_key`) REFERENCES `mappings`(`key`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`relay_item_id`) REFERENCES `relay_items`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_operations_idempotency_key_unique` ON `outbox_operations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `outbox_operations_claim_index` ON `outbox_operations` (`state`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `outbox_operations_partition_index` ON `outbox_operations` (`partition_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `reconciliation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`mapping_key` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`plan_json` text,
	`started_by_discord_user_id` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mapping_key`) REFERENCES `mappings`(`key`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `relay_items` (
	`id` text PRIMARY KEY NOT NULL,
	`mapping_key` text NOT NULL,
	`issue_thread_link_id` integer NOT NULL,
	`source_platform` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`destination_platform` text NOT NULL,
	`destination_kind` text NOT NULL,
	`destination_id` text,
	`parent_source_id` text,
	`source_revision` text NOT NULL,
	`source_hash` text NOT NULL,
	`canonical_hash` text NOT NULL,
	`render_hash` text,
	`render_version` integer DEFAULT 1 NOT NULL,
	`author_id` text NOT NULL,
	`author_username` text NOT NULL,
	`author_display_name` text NOT NULL,
	`author_avatar_url` text,
	`state` text NOT NULL,
	`suppressed_at` integer,
	`deleted_at` integer,
	`minimized_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mapping_key`) REFERENCES `mappings`(`key`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`issue_thread_link_id`) REFERENCES `issue_thread_links`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_items_source_unique` ON `relay_items` (`mapping_key`,`source_platform`,`source_kind`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `relay_items_destination_unique` ON `relay_items` (`mapping_key`,`destination_platform`,`destination_kind`,`destination_id`);--> statement-breakpoint
CREATE INDEX `relay_items_link_index` ON `relay_items` (`issue_thread_link_id`);--> statement-breakpoint
CREATE TABLE `relay_segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`relay_item_id` text NOT NULL,
	`position` integer NOT NULL,
	`discord_message_id` text NOT NULL,
	`render_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`relay_item_id`) REFERENCES `relay_items`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_segments_item_position_unique` ON `relay_segments` (`relay_item_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `relay_segments_message_unique` ON `relay_segments` (`discord_message_id`);--> statement-breakpoint
CREATE TABLE `revision_shadows` (
	`relay_item_id` text PRIMARY KEY NOT NULL,
	`discord_message_id` text NOT NULL,
	`canonical_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`relay_item_id`) REFERENCES `relay_items`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `revision_shadows_discord_message_id_unique` ON `revision_shadows` (`discord_message_id`);--> statement-breakpoint
CREATE TABLE `worker_leases` (
	`name` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`host_label` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`renewed_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
