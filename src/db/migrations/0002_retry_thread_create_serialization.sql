UPDATE `outbox_operations`
SET
	`state` = 'pending',
	`attempt_count` = 0,
	`next_attempt_at` = 0,
	`claim_owner` = NULL,
	`claim_expires_at` = NULL,
	`last_error_code` = NULL,
	`last_error_message` = NULL
WHERE
	`state` = 'dead'
	AND `operation_kind` = 'github.issue.create'
	AND `last_error_code` = 'PAYLOAD_INVALID'
	AND `last_error_message` = 'Expected channel_id to be a string.';
