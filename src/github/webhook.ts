import { createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedConfig } from "@/config/normalize.js";
import type { JsonObject, JsonValue } from "@/core/json.js";
import { isJsonObject, jsonNumber, jsonString, parseJson } from "@/core/json.js";
import type { EnqueueInbox } from "@/db/job-repository.js";

const SIGNATURE_PREFIX = "sha256=";
const DELIVERY_PATTERN = /^[0-9a-f-]{16,64}$/i;
const EVENT_PATTERN = /^[a-z0-9_]{1,64}$/;

export interface NormalizedGitHubWebhook {
	event: EnqueueInbox;
	mappingKey?: string;
	reason?: "pull-request" | "unconfigured-repository" | "unsupported-project-item";
}

export function verifyGitHubSignature(rawBody: Uint8Array, providedSignature: string, secret: string) {
	if (!providedSignature.startsWith(SIGNATURE_PREFIX)) {
		return false;
	}

	const providedHex = providedSignature.slice(SIGNATURE_PREFIX.length);
	if (!/^[0-9a-f]{64}$/i.test(providedHex)) {
		return false;
	}

	const expected = createHmac("sha256", secret).update(rawBody).digest();
	const provided = Buffer.from(providedHex, "hex");
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function normalizeGitHubWebhook(
	config: NormalizedConfig,
	deliveryId: string,
	eventName: string,
	rawBody: string
): NormalizedGitHubWebhook {
	if (!DELIVERY_PATTERN.test(deliveryId)) {
		throw new Error("Invalid X-GitHub-Delivery header.");
	}
	if (!EVENT_PATTERN.test(eventName)) {
		throw new Error("Invalid X-GitHub-Event header.");
	}

	const payload = parseJson(rawBody);
	if (!isJsonObject(payload)) {
		throw new Error("GitHub webhook payload must be a JSON object.");
	}

	const action = jsonString(payload, "action");
	const repository = payload.repository;
	const issue = payload.issue;

	if (eventName === "projects_v2_item") {
		const item = payload.projects_v2_item;
		if (!item || !isJsonObject(item) || jsonString(item, "content_type") !== "Issue") {
			return {
				event: createEvent(deliveryId, eventName, action, payload),
				reason: "unsupported-project-item"
			};
		}
		const contentNodeId = jsonString(item, "content_node_id");
		if (!contentNodeId) {
			throw new Error("GitHub Project item payload is missing content_node_id.");
		}
		return {
			event: {
				...createEvent(deliveryId, eventName, action, payload),
				partitionKey: `github:issue-node:${contentNodeId}`
			}
		};
	}

	if (isJsonObject(issue) && isJsonObject(issue.pull_request)) {
		return {
			event: createEvent(deliveryId, eventName, action, payload),
			reason: "pull-request"
		};
	}

	const repositoryName = repositoryFullName(repository);
	const mappingKey = repositoryName ? findMapping(config, repositoryName) : undefined;
	if (!mappingKey) {
		return {
			event: createEvent(deliveryId, eventName, action, payload),
			reason: "unconfigured-repository"
		};
	}

	return {
		event: {
			...createEvent(deliveryId, eventName, action, payload),
			mappingKey,
			partitionKey: partitionKey(repository, issue, payload)
		},
		mappingKey
	};
}

function createEvent(deliveryId: string, eventName: string, action: string | undefined, payload: JsonValue): EnqueueInbox {
	return {
		correlationId: deliveryId,
		eventKind: action ? `${eventName}.${action}` : eventName,
		idempotencyKey: `github:${deliveryId}`,
		payload,
		platform: "github"
	};
}

function repositoryFullName(value: JsonValue | undefined) {
	if (!value || !isJsonObject(value)) {
		return undefined;
	}
	const fullName = jsonString(value, "full_name");
	if (fullName) {
		return fullName;
	}

	const name = jsonString(value, "name");
	const owner = value.owner;
	const login = owner && isJsonObject(owner) ? jsonString(owner, "login") : undefined;
	return login && name ? `${login}/${name}` : undefined;
}

function findMapping(config: NormalizedConfig, repositoryFullName: string) {
	const normalized = repositoryFullName.toLocaleLowerCase("en-US");
	return Object.entries(config.mappings).find(
		([, mapping]) => `${mapping.repository.owner}/${mapping.repository.name}`.toLocaleLowerCase("en-US") === normalized
	)?.[0];
}

function partitionKey(repository: JsonValue | undefined, issue: JsonValue | undefined, payload: JsonObject) {
	const repositoryId = repository && isJsonObject(repository) ? jsonNumber(repository, "id") : undefined;
	const relatedIssue =
		(issue && isJsonObject(issue) ? issue : undefined) ??
		(payload.parent_issue && isJsonObject(payload.parent_issue) ? payload.parent_issue : undefined) ??
		(payload.blocked_issue && isJsonObject(payload.blocked_issue) ? payload.blocked_issue : undefined);
	const issueNumber = relatedIssue ? jsonNumber(relatedIssue, "number") : undefined;

	if (repositoryId !== undefined && issueNumber !== undefined) {
		return `github:${repositoryId}:issue:${issueNumber}`;
	}

	const discussion = payload.discussion;
	const discussionId = discussion && isJsonObject(discussion) ? jsonNumber(discussion, "id") : undefined;
	return repositoryId !== undefined && discussionId !== undefined
		? `github:${repositoryId}:discussion:${discussionId}`
		: undefined;
}
