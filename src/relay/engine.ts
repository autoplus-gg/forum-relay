import type { BootstrapConfig } from "@/config/index.js";
import type { NormalizedConfig } from "@/config/normalize.js";
import type { JsonObject, JsonValue } from "@/core/json.js";
import { isJsonObject, jsonNumber, jsonString } from "@/core/json.js";
import type { Logger } from "@/core/logger.js";
import type { ClaimedJob, ClaimedOperation, JobRepository } from "@/db/job-repository.js";
import type { IssueThreadLink, RelayAuthor, RelayItem, RelayRepository, StoredAttachment } from "@/db/relay-repository.js";
import { hash } from "@/db/relay-repository.js";
import type { DiscordClient } from "@/discord/client.js";
import { shouldIgnoreStoredDiscordMessage } from "@/discord/message-origin.js";
import { decideDiscordEdit } from "@/domain/conflicts.js";
import type { GitHubClient } from "@/github/client.js";
import { RelayFailure } from "@/jobs/retry-policy.js";
import type { GitHubMediaDownloader } from "@/media/github-download.js";
import { isRecognizedGitHubMediaUrl } from "@/media/safe-download.js";
import type { DiscordMediaProxy } from "@/media/ticketpm.js";
import { renderDiscordToGitHub } from "@/render/discord-to-github.js";
import type { GitHubProjectSummary } from "@/render/github-activity.js";
import { githubUserLink, renderGitHubActivity } from "@/render/github-activity.js";
import { renderGitHubToDiscord, truncateGraphemes } from "@/render/github-to-discord.js";
import { parseGitHubMarkdown } from "@/render/markdown.js";

interface GitHubIssue {
	author: RelayAuthor;
	body: string;
	htmlUrl: string;
	id: number;
	labels: string[];
	locked: boolean;
	nodeId: string;
	number: number;
	state: "closed" | "open";
	stateReason?: string;
	title: string;
	updatedAt: string;
}

const DISCORD_RENDER_VERSION = 4;

interface GitHubComment {
	author: RelayAuthor;
	body: string;
	htmlUrl: string;
	id: number;
	nodeId: string;
	updatedAt: string;
}

interface DiscordMessage {
	attachments: {
		contentType?: string;
		filename: string;
		id: string;
		size: number;
		url: string;
	}[];
	author: RelayAuthor;
	channelId: string;
	content: string;
	id: string;
	revision: string;
}

interface EngineOptions {
	config: NormalizedConfig;
	discord: DiscordClient;
	github: GitHubClient;
	githubMedia: GitHubMediaDownloader;
	jobs: JobRepository;
	logger: Logger;
	media: DiscordMediaProxy;
	relay: RelayRepository;
}

export class RelayEngine {
	readonly #config: NormalizedConfig;
	readonly #discord: DiscordClient;
	readonly #github: GitHubClient;
	readonly #githubMedia: GitHubMediaDownloader;
	readonly #jobs: JobRepository;
	readonly #logger: Logger;
	readonly #media: DiscordMediaProxy;
	readonly #relay: RelayRepository;

	public constructor(options: EngineOptions) {
		this.#config = options.config;
		this.#discord = options.discord;
		this.#github = options.github;
		this.#githubMedia = options.githubMedia;
		this.#jobs = options.jobs;
		this.#logger = options.logger;
		this.#media = options.media;
		this.#relay = options.relay;
	}

	public async processInbox(job: ClaimedJob) {
		if (job.platform === "github" && job.eventKind.startsWith("projects_v2_item.")) {
			await this.#processGitHubProject(job.eventKind, requiredObject(job.payload, "GitHub Project webhook"), job.correlationId);
			return;
		}
		if (!job.mappingKey) {
			return;
		}
		if (job.platform === "github") {
			await this.#processGitHub(job.mappingKey, job.eventKind, requiredObject(job.payload, "GitHub webhook"), job.correlationId);
			return;
		}
		if (job.platform === "discord") {
			await this.#processDiscord(job.mappingKey, job.eventKind, requiredObject(job.payload, "Discord event"));
		}
	}

	public async processOutbox(operation: ClaimedOperation): Promise<JsonValue> {
		const payload = requiredObject(operation.payload, "outbox operation");
		switch (operation.operationKind) {
			case "discord.item.sync":
				return this.#syncDiscordItem(operation.mappingKey, payload);
			case "discord.item.delete":
				return this.#deleteDiscordItem(operation.mappingKey, payload);
			case "discord.issue.lifecycle":
				return this.#syncDiscordLifecycle(operation.mappingKey, payload);
			case "github.issue.create":
				return this.#createGitHubIssue(operation.mappingKey, payload);
			case "github.item.sync":
				return this.#syncGitHubItem(operation.mappingKey, payload);
			case "github.item.delete":
				return this.#deleteGitHubItem(operation.mappingKey, payload);
			case "github.issue.lifecycle":
				return this.#syncGitHubLifecycle(operation.mappingKey, payload);
			case "media.attachment.upload":
				return this.#uploadAttachment(operation.mappingKey, payload, operation.correlationId);
			default:
				throw new RelayFailure(`Unsupported outbox operation ${operation.operationKind}.`, "invalid", "OPERATION_UNSUPPORTED");
		}
	}

	async #processGitHub(mappingKey: string, eventKind: string, payload: JsonObject, eventId: string) {
		if (eventKind.startsWith("label.")) {
			await this.#syncLabelDefinitions(mappingKey);
			return;
		}
		if (eventKind === "bootstrap.github.state") {
			const issue = parseGitHubIssue(payload);
			const link = await this.#relay.findLinkByGitHub(mappingKey, issue.id);
			if (!link) {
				throw new RelayFailure("Bootstrap issue relationship is not ready.", "temporary", "LINK_PENDING");
			}
			if (issue.state === "closed") {
				await this.#enqueueLifecycle(mappingKey, link, "closed", payload, eventId, eventKind);
			}
			if (issue.locked) {
				await this.#enqueueLifecycle(mappingKey, link, "locked", payload, eventId, eventKind);
			}
			return;
		}
		if (eventKind.startsWith("issues.")) {
			const issue = parseGitHubIssue(payload);
			if (eventKind === "issues.deleted") {
				const link = await this.#relay.findLinkByGitHub(mappingKey, issue.id);
				if (link) {
					await this.#enqueueLifecycle(mappingKey, link, "source-deleted", payload, eventId, eventKind);
				}
				return;
			}

			const previousLink = await this.#relay.findLinkByGitHub(mappingKey, issue.id);
			const liveWebhook =
				payload.forum_relay_bootstrap !== true && optionalString(payload, "action") === eventKind.slice("issues.".length);
			if (await this.#shouldIgnoreUnthreadedGitHubIssue(mappingKey, issue, Boolean(previousLink?.discordThreadId), liveWebhook)) {
				this.#logger.debug("Ignored an unlinked closed GitHub issue excluded by the open-only bootstrap filter.", {
					eventKind,
					githubIssueId: issue.id,
					mappingKey
				});
				return;
			}
			const link = await this.#relay.ensureGitHubIssueLink(mappingKey, issue);
			const discordOriginBody = await this.#relay.findRelayItemByDestination(
				mappingKey,
				"github",
				"issue-body",
				String(issue.id)
			);
			const githubOriginBody = await this.#relay.findRelayItem(mappingKey, "github", "issue-body", String(issue.id));
			const ownBotEvent = isOwnGitHubBotEvent(this.#github, payload);
			const suppressBodyEcho = shouldSuppressGitHubBodyEcho(
				Boolean(discordOriginBody),
				discordOriginBody?.renderHash === hash(issue.body),
				eventKind,
				liveWebhook,
				ownBotEvent
			);
			if (suppressBodyEcho && githubOriginBody?.state === "ACTIVE") {
				await this.#jobs.enqueueOutbox({
					correlationId: crypto.randomUUID(),
					idempotencyKey: `discord:echo-delete:${githubOriginBody.id}:${eventId}`,
					mappingKey,
					operationKind: "discord.item.delete",
					// Cleanup cannot hold lifecycle updates behind a failed message deletion.
					partitionKey: `relay-item:${githubOriginBody.id}`,
					payload: { relayItemId: githubOriginBody.id },
					platform: "discord",
					relayItemId: githubOriginBody.id
				});
			}
			if (
				!suppressBodyEcho &&
				(eventKind === "issues.opened" ||
					eventKind === "issues.edited" ||
					(eventKind === "issues.reopened" && !previousLink?.discordThreadId))
			) {
				const item = await this.#relay.upsertRelayItem({
					author: issue.author,
					destinationKind: "forum-starter",
					destinationPlatform: "discord",
					issueThreadLinkId: link.id,
					mappingKey,
					sourceBody: issue.body,
					sourceId: String(issue.id),
					sourceKind: "issue-body",
					sourcePlatform: "github",
					sourceRevision: issue.updatedAt
				});
				await this.#enqueueDiscordSync(mappingKey, link, item, issue.htmlUrl, repositoryUrl(payload), issue.title, issue.labels);
				if (eventKind === "issues.reopened" && !previousLink?.discordThreadId) {
					const historical = (await this.#github.bootstrapIssues(mappingKey)).find((candidate) => candidate.id === issue.id);
					for (const comment of historical?.comments ?? []) {
						const commentObject = requiredObject(comment.comment, "comment");
						await this.#jobs.enqueueInbox({
							correlationId: crypto.randomUUID(),
							eventKind: "issue_comment.created",
							idempotencyKey: `reopened-history:${mappingKey}:comment:${String(commentObject.id)}`,
							mappingKey,
							partitionKey: `github:issue:${issue.id}`,
							payload: comment,
							platform: "github"
						});
					}
				}
			}
			if (eventKind === "issues.edited" && previousLink) {
				// Full reconciliation represents the current issue as an edit. Compare
				// the state captured before ensureGitHubIssueLink updated it so missed
				// close/reopen and lock/unlock webhooks are repaired as well.
				for (const action of reconciliationLifecycleRepairs(
					issue.state,
					issue.locked,
					previousLink.state,
					previousLink.locked,
					reconciliationDiscordState(payload)
				)) {
					await this.#enqueueLifecycle(mappingKey, link, action, payload, eventId, eventKind);
				}
			}

			if (
				eventKind === "issues.closed" ||
				eventKind === "issues.reopened" ||
				eventKind === "issues.locked" ||
				eventKind === "issues.unlocked"
			) {
				await this.#enqueueLifecycle(
					mappingKey,
					link,
					eventKind.slice("issues.".length),
					payload,
					eventId,
					ownBotEvent ? undefined : eventKind
				);
			}
			if (eventKind === "issues.labeled" || eventKind === "issues.unlabeled") {
				// A newly created label can be applied before its separate label webhook is processed.
				await this.#syncLabelDefinitions(mappingKey);
				await this.#enqueueLifecycle(mappingKey, link, "labels", payload, eventId, ownBotEvent ? undefined : eventKind);
			} else if (!ownBotEvent && isLiveIssueActivity(eventKind, payload)) {
				await this.#enqueueLifecycle(mappingKey, link, "activity", payload, eventId, eventKind);
			}
			return;
		}

		if (eventKind.startsWith("issue_comment.")) {
			const issue = parseGitHubIssue(payload);
			const previousLink = await this.#relay.findLinkByGitHub(mappingKey, issue.id);
			if (
				await this.#shouldIgnoreUnthreadedGitHubIssue(
					mappingKey,
					issue,
					Boolean(previousLink?.discordThreadId),
					payload.forum_relay_bootstrap !== true && optionalString(payload, "action") !== undefined
				)
			) {
				return;
			}
			const link = previousLink ?? (await this.#relay.ensureGitHubIssueLink(mappingKey, issue));
			const comment = parseGitHubComment(payload);
			const discordOrigin = await this.#relay.findRelayItemByDestination(
				mappingKey,
				"github",
				"issue-comment",
				String(comment.id)
			);
			if (discordOrigin) {
				return;
			}
			const existing = await this.#relay.findRelayItem(mappingKey, "github", "issue-comment", String(comment.id));

			if (eventKind === "issue_comment.deleted") {
				if (existing) {
					await this.#jobs.enqueueOutbox({
						correlationId: crypto.randomUUID(),
						idempotencyKey: `discord:delete:${existing.id}`,
						mappingKey,
						operationKind: "discord.item.delete",
						partitionKey: `link:${link.id}`,
						payload: { relayItemId: existing.id },
						platform: "discord",
						relayItemId: existing.id
					});
				}
				return;
			}

			const item = await this.#relay.upsertRelayItem({
				author: comment.author,
				destinationKind: "forum-message",
				destinationPlatform: "discord",
				issueThreadLinkId: link.id,
				mappingKey,
				sourceBody: comment.body,
				sourceId: String(comment.id),
				sourceKind: "issue-comment",
				sourcePlatform: "github",
				sourceRevision: comment.updatedAt
			});
			await this.#enqueueDiscordSync(mappingKey, link, item, comment.htmlUrl, repositoryUrl(payload), issue.title, issue.labels);
			return;
		}

		if (eventKind.startsWith("sub_issues.") || eventKind.startsWith("issue_dependencies.")) {
			const issue = relatedGitHubIssue(payload);
			const link = await this.#relay.findLinkByGitHub(mappingKey, requiredNumber(issue, "id"));
			if (link) {
				await this.#enqueueLifecycle(mappingKey, link, "activity", payload, eventId, eventKind);
			}
		}
	}

	async #processGitHubProject(eventKind: string, payload: JsonObject, eventId: string) {
		const item = requiredObject(payload.projects_v2_item, "GitHub Project item");
		if (requiredString(item, "content_type") !== "Issue") {
			return;
		}
		const link = await this.#relay.findLinkByGitHubNode(requiredString(item, "content_node_id"));
		if (!link) {
			this.#logger.debug("Ignored GitHub Project activity for an issue outside configured mappings.", {
				contentNodeId: requiredString(item, "content_node_id"),
				eventKind
			});
			return;
		}
		await this.#enqueueLifecycle(link.mappingKey, link, "activity", payload, eventId, eventKind);
	}

	async #syncLabelDefinitions(mappingKey: string) {
		await this.#github.syncLabels(mappingKey);
		await this.#discord.syncForumTags(mappingKey);
	}

	async #shouldIgnoreUnthreadedGitHubIssue(
		mappingKey: string,
		issue: GitHubIssue,
		hasDiscordThread: boolean,
		verifyCurrentState: boolean
	) {
		const bootstrap = this.#config.mappings[mappingKey]?.bootstrap;
		if (shouldIgnoreUnlinkedGitHubIssue(hasDiscordThread, issue.state, bootstrap)) {
			return true;
		}
		if (hasDiscordThread || !verifyCurrentState || bootstrap?.source !== "github" || bootstrap.issueFilter !== "open-only") {
			return false;
		}
		const current = await this.#github.currentIssue(mappingKey, issue.number);
		return shouldIgnoreUnlinkedGitHubIssue(false, issue.state, bootstrap, current.state);
	}

	async #processDiscord(mappingKey: string, eventKind: string, payload: JsonObject) {
		if (eventKind === "bootstrap.discord.state") {
			const threadId = requiredString(payload, "threadId");
			const link = await this.#relay.findLinkByDiscord(mappingKey, threadId);
			if (!link) {
				throw new RelayFailure("Bootstrap thread relationship is not ready.", "temporary", "LINK_PENDING");
			}
			const dependencies: string[] = [];
			if (payload.state === "closed") {
				const close = await this.#enqueueGitHubLifecycle(mappingKey, link, "close", {
					reason: "completed"
				});
				if (close) {
					dependencies.push(close);
				}
			}
			if (payload.locked === true) {
				await this.#enqueueGitHubLifecycle(mappingKey, link, "lock", {}, dependencies);
			}
			return;
		}
		if (eventKind === "thread.create") {
			const threadId = requiredString(payload, "id");
			if (await this.#relay.findLinkByDiscord(mappingKey, threadId)) {
				return;
			}
			// Keep Discord's raw wire shape in the durable job. The worker parses
			// it after dequeueing; normalizing here would turn channel_id into
			// channelId and make that second boundary validation reject the event.
			const starter = requiredObject(jsonRoundTrip(await this.#discord.fetchMessage(threadId, threadId)), "message");
			if (shouldIgnoreStoredDiscordMessage(starter, this.#config.clientId)) {
				return;
			}
			const title = requiredString(payload, "name");
			const tags = stringArray(payload.applied_tags);
			const labels = await this.#relay.githubLabelsForTags(mappingKey, tags);
			await this.#jobs.enqueueOutbox({
				correlationId: crypto.randomUUID(),
				idempotencyKey: `github:issue:create:discord-thread:${threadId}`,
				mappingKey,
				operationKind: "github.issue.create",
				partitionKey: `discord:thread:${threadId}`,
				payload: {
					labels,
					message: jsonRoundTrip(starter),
					threadId,
					title
				},
				platform: "github"
			});
			return;
		}

		if (eventKind === "thread.delete") {
			const threadId = requiredString(payload, "id");
			const link = await this.#relay.findLinkByDiscord(mappingKey, threadId);
			if (link) {
				this.#logger.warn("A linked Discord thread was deleted; the GitHub issue is preserved.", {
					mappingKey,
					threadId
				});
			}
			return;
		}

		if (eventKind === "thread.update") {
			await this.#queueAuditClassification(mappingKey, payload);
			return;
		}

		if (eventKind.startsWith("message.")) {
			if (eventKind !== "message.delete" && shouldIgnoreStoredDiscordMessage(payload, this.#config.clientId)) {
				return;
			}
			const threadId = requiredString(payload, "channel_id");
			const messageId = requiredString(payload, "id");
			if (messageId === threadId) {
				return;
			}
			const link = await this.#relay.findLinkByDiscord(mappingKey, threadId);
			if (!link) {
				throw new RelayFailure("The Discord thread relationship is not ready yet.", "temporary", "LINK_PENDING");
			}
			const existing = await this.#relay.findRelayItem(mappingKey, "discord", "forum-message", messageId);
			if (eventKind === "message.delete") {
				if (existing) {
					await this.#jobs.enqueueOutbox({
						correlationId: crypto.randomUUID(),
						idempotencyKey: `github:delete:${existing.id}`,
						mappingKey,
						operationKind: "github.item.delete",
						partitionKey: `link:${link.id}`,
						payload: { relayItemId: existing.id },
						platform: "github",
						relayItemId: existing.id
					});
				}
				return;
			}

			const fullPayload =
				eventKind === "message.update"
					? requiredObject(jsonRoundTrip(await this.#discord.fetchMessage(threadId, messageId)), "message")
					: payload;
			const message = parseDiscordMessage(fullPayload);
			const item = await this.#relay.upsertRelayItem({
				author: message.author,
				destinationKind: "issue-comment",
				destinationPlatform: "github",
				issueThreadLinkId: link.id,
				mappingKey,
				sourceBody: message.content,
				sourceId: message.id,
				sourceKind: "forum-message",
				sourcePlatform: "discord",
				sourceRevision: message.revision
			});
			await this.#persistAttachments(item, message.attachments);
			const dependencies: string[] = [];
			if (link.state === "closed" && !link.locked) {
				const lifecycle = await this.#jobs.enqueueOutbox({
					correlationId: crypto.randomUUID(),
					idempotencyKey: `github:lifecycle:${link.id}:reopen:message:${message.id}:${message.revision}`,
					mappingKey,
					operationKind: "github.issue.lifecycle",
					partitionKey: `link:${link.id}`,
					payload: {
						action: "reopen",
						actor: jsonRoundTrip(message.author),
						linkId: link.id
					},
					platform: "github"
				});
				if (lifecycle) {
					dependencies.push(lifecycle);
				}
			}
			await this.#enqueueGitHubSync(mappingKey, link, item, message.revision, dependencies);
		}
	}

	async #enqueueDiscordSync(
		mappingKey: string,
		link: IssueThreadLink,
		item: RelayItem,
		jumpUrl: string,
		repository: string,
		title: string,
		labels: readonly string[]
	) {
		const revision = discordSyncFingerprint({
			body: item.sourceBody,
			jumpUrl,
			labels,
			repository,
			title
		});
		await this.#jobs.enqueueOutbox({
			correlationId: crypto.randomUUID(),
			idempotencyKey: `discord:sync:${item.id}:${revision}`,
			mappingKey,
			operationKind: "discord.item.sync",
			partitionKey: `link:${link.id}`,
			payload: { jumpUrl, labels: [...labels], relayItemId: item.id, repository, title },
			platform: "discord",
			relayItemId: item.id
		});
	}

	async #enqueueGitHubSync(
		mappingKey: string,
		link: IssueThreadLink,
		item: RelayItem,
		revision: string,
		dependsOn: readonly string[] = []
	) {
		return this.#jobs.enqueueOutbox({
			correlationId: crypto.randomUUID(),
			dependsOn,
			idempotencyKey: `github:sync:${item.id}:${revision}`,
			mappingKey,
			operationKind: "github.item.sync",
			partitionKey: `link:${link.id}`,
			payload: { relayItemId: item.id },
			platform: "github",
			relayItemId: item.id
		});
	}

	async #enqueueLifecycle(
		mappingKey: string,
		link: IssueThreadLink,
		action: string,
		payload: JsonObject,
		eventId = eventRevision(payload),
		activityKind?: string
	) {
		await this.#jobs.enqueueOutbox({
			correlationId: crypto.randomUUID(),
			idempotencyKey: `discord:lifecycle:${link.id}:${action}:${eventId}`,
			mappingKey,
			operationKind: "discord.issue.lifecycle",
			partitionKey: `link:${link.id}`,
			payload: activityKind
				? { action, activityKind, linkId: link.id, webhook: payload }
				: { action, linkId: link.id, webhook: payload },
			platform: "discord"
		});
	}

	async #enqueueGitHubLifecycle(
		mappingKey: string,
		link: IssueThreadLink,
		action: string,
		extra: JsonObject,
		dependsOn: readonly string[] = []
	) {
		return this.#jobs.enqueueOutbox({
			correlationId: crypto.randomUUID(),
			dependsOn,
			idempotencyKey: `github:lifecycle:bootstrap:${link.id}:${action}`,
			mappingKey,
			operationKind: "github.issue.lifecycle",
			partitionKey: `link:${link.id}`,
			payload: { action, linkId: link.id, ...extra },
			platform: "github"
		});
	}

	async #syncDiscordItem(mappingKey: string, payload: JsonObject): Promise<JsonValue> {
		const relayItemId = requiredString(payload, "relayItemId");
		const item = await this.#requiredRelayItem(relayItemId);
		const link = await this.#requiredLink(item.issueThreadLinkId);
		const jumpUrl = requiredString(payload, "jumpUrl");
		const repository = requiredString(payload, "repository");
		const title = requiredString(payload, "title");
		const mediaAttachments = await this.#downloadGitHubMedia(mappingKey, item.sourceBody, repository, relayItemId);
		const rendered = renderGitHubToDiscord({
			authorAvatarUrl: item.author.avatarUrl,
			authorUsername: item.author.username,
			body: item.sourceBody,
			jumpUrl,
			mediaAttachments,
			repositoryUrl: repository
		});
		const existingSegments = await this.#relay.getSegments(item.id);
		const messageIds: string[] = [];
		const renderHashes: string[] = [];
		let threadId = link.discordThreadId;
		let createdThread = false;
		if (threadId && item.sourceKind === "issue-body") {
			await this.#discord.editThread(threadId, {
				appliedTagIds: await this.#relay.discordTagsForLabels(mappingKey, stringArray(payload.labels)),
				name: truncateGraphemes(title, 100)
			});
		}
		const temporarilyUnarchived = Boolean(threadId && link.state === "closed" && item.sourceKind === "issue-comment");
		if (temporarilyUnarchived && threadId) {
			await this.#discord.editThread(threadId, { archived: false });
		}

		for (const [position, segment] of rendered.entries()) {
			const renderHash = hash(JSON.stringify(segment.components));
			const existing = existingSegments[position];
			if (existing && threadId) {
				if (existing.renderHash !== renderHash) {
					await this.#discord.editMessage(mappingKey, threadId, existing.messageId, segment);
				}
				messageIds.push(existing.messageId);
				renderHashes.push(renderHash);
				continue;
			}

			if (!threadId) {
				const tagIds = await this.#relay.discordTagsForLabels(mappingKey, stringArray(payload.labels));
				const created = await this.#discord.createThread(mappingKey, truncateGraphemes(title, 100), segment, tagIds);
				if (!created.threadId) {
					throw new RelayFailure("Discord did not return the created forum thread ID.", "temporary", "THREAD_ID_MISSING");
				}
				threadId = created.threadId;
				createdThread = true;
				await this.#relay.attachDiscordThread(link.id, created.threadId);
				await this.#relay.setDestination(item.id, created.messageId);
				messageIds.push(created.messageId);
			} else {
				const created = await this.#discord.createMessage(mappingKey, threadId, segment);
				messageIds.push(created.messageId);
				if (!item.destinationId) {
					await this.#relay.setDestination(item.id, created.messageId);
				}
			}
			renderHashes.push(renderHash);
		}

		if (!threadId) {
			throw new RelayFailure("Discord did not create or resolve a thread.", "temporary", "THREAD_MISSING");
		}
		for (const stale of existingSegments.slice(rendered.length)) {
			await this.#discord.deleteMessage(mappingKey, threadId, stale.messageId);
		}
		await this.#relay.replaceSegments(item.id, messageIds, renderHashes);
		if (temporarilyUnarchived) {
			await this.#discord.editThread(threadId, { archived: true });
		}
		if (createdThread) {
			const resumed = await this.#jobs.resumeThreadPendingLifecycles(`link:${link.id}`);
			if (resumed > 0) {
				this.#logger.info("Resumed lifecycle work that had been waiting for thread creation.", {
					linkId: link.id,
					mappingKey,
					resumed
				});
			}
		}
		return { messageIds, threadId };
	}

	async #downloadGitHubMedia(mappingKey: string, body: string, repositoryUrl: string, relayItemId: string) {
		const attachments = new Map<string, Awaited<ReturnType<GitHubMediaDownloader["download"]>>["file"]>();
		const media = parseGitHubMarkdown(body, repositoryUrl).media;
		const githubMedia = media.filter((token) => isRecognizedGitHubMediaUrl(token.url));
		if (githubMedia.length === 0) {
			return attachments;
		}
		const renderedUrls = await this.#github.renderedMediaUrls(mappingKey, body);
		const resolvedUrls = new Map<string, string>();
		for (const [index, token] of media.entries()) {
			if (!isRecognizedGitHubMediaUrl(token.url) || resolvedUrls.has(token.url)) {
				continue;
			}
			const renderedUrl = renderedUrls[index];
			resolvedUrls.set(token.url, renderedUrl && isRecognizedGitHubMediaUrl(renderedUrl) ? renderedUrl : token.url);
		}

		for (const [sourceUrl, downloadUrl] of resolvedUrls) {
			try {
				const downloaded = await this.#githubMedia.download(mappingKey, downloadUrl);
				attachments.set(sourceUrl, downloaded.file);
			} catch (error) {
				if (error instanceof RelayFailure && (error.category === "invalid" || error.category === "not-found")) {
					this.#logger.warn("Could not download a GitHub image; rendering it as a link instead.", {
						error,
						mappingKey,
						relayItemId
					});
					continue;
				}
				throw error;
			}
		}
		return attachments;
	}

	async #deleteDiscordItem(mappingKey: string, payload: JsonObject): Promise<JsonValue> {
		const item = await this.#requiredRelayItem(requiredString(payload, "relayItemId"));
		const link = await this.#requiredLink(item.issueThreadLinkId);
		if (!link.discordThreadId) {
			return { deleted: false };
		}
		const segments = await this.#relay.getSegments(item.id);
		for (const segment of segments) {
			try {
				await this.#discord.deleteMessage(mappingKey, link.discordThreadId, segment.messageId);
			} catch (error) {
				if (!(error instanceof RelayFailure && error.category === "not-found")) {
					throw error;
				}
			}
		}
		await this.#relay.markDeleted(item.id);
		return { deleted: true };
	}

	async #syncDiscordLifecycle(mappingKey: string, payload: JsonObject): Promise<JsonValue> {
		let link = await this.#requiredLink(requiredNumber(payload, "linkId"));
		const action = requiredString(payload, "action");
		const webhook = requiredObject(payload.webhook, "webhook");
		if (!link.discordThreadId) {
			if (shouldIgnoreUnlinkedGitHubIssue(false, link.state, this.#config.mappings[mappingKey]?.bootstrap)) {
				this.#logger.debug("Discarded lifecycle work for a closed issue excluded by the open-only filter.", {
					action,
					githubIssueId: link.githubIssueId,
					mappingKey
				});
				return { action, ignored: true, reason: "open-only-unlinked-closed-issue" };
			}
			if (action === "activity" || action === "labels" || action === "source-deleted") {
				return { action, ignored: true, reason: "lifecycle-before-starter" };
			}
			if (!isJsonObject(webhook.issue)) {
				throw new RelayFailure("Discord thread is not created yet.", "temporary", "THREAD_PENDING");
			}
			let starterWebhook = webhook;
			const bootstrap = this.#config.mappings[mappingKey]?.bootstrap;
			if (bootstrap?.source === "github" && bootstrap.issueFilter === "open-only") {
				const current = await this.#github.currentIssue(mappingKey, link.githubIssueNumber);
				if (current.state === "closed") {
					return { action, ignored: true, reason: "open-only-currently-closed-issue" };
				}
				starterWebhook = current.payload;
			}
			link = await this.#materializeDiscordStarter(mappingKey, link, starterWebhook);
		}
		const threadId = link.discordThreadId;
		if (!threadId) {
			throw new RelayFailure("Discord thread is not created yet.", "temporary", "THREAD_PENDING");
		}
		const activityKind = optionalString(payload, "activityKind");

		if (action === "activity") {
			await this.#postGitHubActivity(mappingKey, link, webhook, requiredActivityKind(activityKind));
			return { action, threadId };
		}

		const issue = parseGitHubIssue(webhook);
		const githubActor = parseGitHubActor(webhook.sender);
		const pendingClose = parsePendingClose(link.status);
		const actor = pendingClose?.actor ?? githubActor;
		const actorLabel = pendingClose
			? `**${escapeDiscordMarkdown(actor.username)}**`
			: githubUserLink(actor.username, githubActorProfileUrl(webhook.sender, actor.username));

		if (action === "closed") {
			let githubDuplicate: Awaited<ReturnType<GitHubClient["duplicateOf"]>>;
			if (!pendingClose?.duplicateUrl && issue.stateReason === "duplicate") {
				try {
					githubDuplicate = await this.#github.duplicateOf(mappingKey, link.githubIssueNumber);
				} catch (error) {
					// A duplicate target enriches the close notice, but it must never
					// prevent the authoritative issue state from reaching Discord.
					this.#logger.warn("Could not resolve the GitHub duplicate target; closing the Discord thread without its link.", {
						error: error instanceof Error ? error : String(error),
						githubIssueNumber: link.githubIssueNumber,
						mappingKey
					});
				}
			}
			const duplicateUrl = pendingClose?.duplicateUrl ?? githubDuplicate?.url;
			const discordDuplicateUrl = duplicateUrl ? await this.#mappedDiscordThreadUrl(mappingKey, duplicateUrl) : undefined;
			const reason = formatGitHubCloseReason(
				duplicateUrl ? "duplicate" : (pendingClose?.reason ?? issue.stateReason),
				duplicateUrl,
				discordDuplicateUrl
			);
			await this.#discord.createMessage(mappingKey, threadId, {
				avatarUrl: actor.avatarUrl,
				components: [{ type: 10, content: `> Closed by ${actorLabel} ${reason} on GitHub` }],
				username: actor.username
			});
			await this.#discord.editThread(threadId, { archived: true });
			if (pendingClose) {
				await this.#relay.markLinkStatus(link.id, "ACTIVE");
			}
		} else if (action === "reopened") {
			await this.#discord.editThread(threadId, { archived: issue.locked, locked: issue.locked });
			if (activityKind && !issue.locked) {
				await this.#postGitHubActivity(mappingKey, { ...link, locked: issue.locked, state: "open" }, webhook, activityKind);
			}
		} else if (action === "locked") {
			await this.#discord.createMessage(mappingKey, threadId, {
				avatarUrl: actor.avatarUrl,
				components: [{ type: 10, content: `> Locked by ${actorLabel} on GitHub` }],
				username: actor.username
			});
			await this.#discord.editThread(threadId, { archived: true, locked: true });
		} else if (action === "unlocked") {
			await this.#discord.editThread(threadId, {
				archived: issue.state === "closed",
				locked: false
			});
			if (activityKind) {
				await this.#postGitHubActivity(mappingKey, { ...link, locked: false }, webhook, activityKind);
			}
		} else if (action === "labels") {
			await this.#discord.editThread(threadId, {
				appliedTagIds: await this.#relay.discordTagsForLabels(mappingKey, issue.labels)
			});
			if (activityKind) {
				await this.#postGitHubActivity(mappingKey, link, webhook, activityKind);
			}
		} else if (action === "source-deleted") {
			await this.#discord.editThread(threadId, { archived: true, locked: true });
		}
		return { action, threadId };
	}

	async #mappedDiscordThreadUrl(mappingKey: string, githubIssueUrl: string) {
		const mapping = this.#config.mappings[mappingKey];
		if (!mapping) {
			return undefined;
		}
		let url: URL;
		try {
			url = new URL(githubIssueUrl);
		} catch {
			return undefined;
		}
		const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
		if (!match || url.hostname !== "github.com") {
			return undefined;
		}
		if (
			match[1]?.toLocaleLowerCase("en-US") !== mapping.repository.owner.toLocaleLowerCase("en-US") ||
			match[2]?.toLocaleLowerCase("en-US") !== mapping.repository.name.toLocaleLowerCase("en-US")
		) {
			return undefined;
		}
		const issueNumber = Number(match[3]);
		const duplicateLink = await this.#relay.findLinkByGitHubNumber(mappingKey, issueNumber);
		return duplicateLink?.discordThreadId
			? `https://discord.com/channels/${this.#config.guildId}/${duplicateLink.discordThreadId}`
			: undefined;
	}

	async #materializeDiscordStarter(mappingKey: string, link: IssueThreadLink, webhook: JsonObject) {
		const issue = parseGitHubIssue(webhook);
		const item = await this.#relay.upsertRelayItem({
			author: issue.author,
			destinationKind: "forum-starter",
			destinationPlatform: "discord",
			issueThreadLinkId: link.id,
			mappingKey,
			sourceBody: issue.body,
			sourceId: String(issue.id),
			sourceKind: "issue-body",
			sourcePlatform: "github",
			sourceRevision: issue.updatedAt
		});
		await this.#syncDiscordItem(mappingKey, {
			jumpUrl: issue.htmlUrl,
			labels: issue.labels,
			relayItemId: item.id,
			repository: repositoryUrl(webhook),
			title: issue.title
		});
		const materialized = await this.#requiredLink(link.id);
		this.#logger.info("Materialized a missing Discord starter before applying GitHub lifecycle work.", {
			githubIssueId: issue.id,
			linkId: link.id,
			mappingKey,
			threadId: materialized.discordThreadId
		});
		return materialized;
	}

	async #postGitHubActivity(mappingKey: string, link: IssueThreadLink, webhook: JsonObject, eventKind: string) {
		if (!link.discordThreadId) {
			throw new RelayFailure("Discord thread is not created yet.", "temporary", "THREAD_PENDING");
		}

		const projectItem =
			eventKind.startsWith("projects_v2_item.") && webhook.projects_v2_item && isJsonObject(webhook.projects_v2_item)
				? webhook.projects_v2_item
				: undefined;
		const projectNodeId = projectItem ? optionalString(projectItem, "project_node_id") : undefined;
		const projectItemNodeId = projectItem ? optionalString(projectItem, "node_id") : undefined;
		let project: GitHubProjectSummary | undefined;
		try {
			project = projectNodeId
				? await this.#github.projectV2(mappingKey, projectNodeId)
				: projectItemNodeId
					? await this.#github.projectV2ForItem(mappingKey, projectItemNodeId)
					: undefined;
		} catch (error) {
			// Project metadata only improves the activity label. The webhook still
			// contains enough information to emit a useful generic activity entry.
			this.#logger.warn("Could not resolve GitHub Project metadata; posting the activity without project details.", {
				error: error instanceof Error ? error : String(error),
				eventKind,
				mappingKey
			});
		}
		const rendered = renderGitHubActivity(eventKind, webhook, project);
		if (!rendered) {
			return;
		}

		const temporarilyUnarchived = link.state === "closed" && !link.locked;
		if (temporarilyUnarchived) {
			await this.#discord.editThread(link.discordThreadId, { archived: false });
		}
		await this.#discord.createMessage(mappingKey, link.discordThreadId, {
			avatarUrl: rendered.author.avatarUrl,
			components: [{ type: 10, content: rendered.content }],
			username: rendered.author.username
		});
		if (temporarilyUnarchived) {
			await this.#discord.editThread(link.discordThreadId, { archived: true });
		}
	}

	async #createGitHubIssue(mappingKey: string, payload: JsonObject): Promise<JsonValue> {
		const threadId = requiredString(payload, "threadId");
		const existing = await this.#relay.findLinkByDiscord(mappingKey, threadId);
		if (existing) {
			return { issueId: existing.githubIssueId, issueNumber: existing.githubIssueNumber };
		}
		const message = parseDiscordMessage(requiredObject(payload.message, "message"));
		const title = requiredString(payload, "title");
		const body = renderDiscordToGitHub({
			attachments: message.attachments.map((attachment) => ({ ...attachment, state: "pending" as const })),
			author: message.author,
			content: message.content,
			context: emptyDiscordContext(this.#config.guildId, threadId),
			messageId: message.id
		});
		const created = await this.#github.createIssue({
			body,
			labels: stringArray(payload.labels),
			mappingKey,
			title
		});
		const link = await this.#relay.createDiscordOriginLink(mappingKey, threadId, title, {
			id: created.id,
			nodeId: created.nodeId,
			number: created.number,
			title
		});
		const item = await this.#relay.upsertRelayItem({
			author: message.author,
			destinationKind: "issue-body",
			destinationPlatform: "github",
			issueThreadLinkId: link.id,
			mappingKey,
			sourceBody: message.content,
			sourceId: message.id,
			sourceKind: "thread-starter",
			sourcePlatform: "discord",
			sourceRevision: message.revision
		});
		await this.#relay.setDestination(item.id, String(created.id));
		await this.#relay.setRenderHash(item.id, hash(body));
		await this.#persistAttachments(item, message.attachments);
		await this.#enqueueGitHubSync(mappingKey, link, item, `created:${message.revision}`);
		return { issueId: created.id, issueNumber: created.number, url: created.url };
	}

	async #syncGitHubItem(mappingKey: string, payload: JsonObject): Promise<JsonValue> {
		const item = await this.#requiredRelayItem(requiredString(payload, "relayItemId"));
		const link = await this.#requiredLink(item.issueThreadLinkId);
		const attachments = await this.#relay.attachments(item.id);
		const body = renderDiscordToGitHub({
			attachments: attachments.map(renderAttachment),
			author: item.author,
			content: item.sourceBody,
			context: emptyDiscordContext(this.#config.guildId, link.discordThreadId ?? item.sourceId),
			messageId: item.sourceId
		});

		if (item.sourceKind === "thread-starter") {
			const remote = await this.#github.issueBody(mappingKey, link.githubIssueNumber);
			if (decideDiscordEdit(item.renderHash, hash(remote.body)) === "preserve-github") {
				await this.#recordConflict(mappingKey, link, item, hash(remote.body));
				return { conflict: true, issueNumber: link.githubIssueNumber };
			}
			await this.#github.updateIssue(mappingKey, link.githubIssueNumber, { body });
			await this.#relay.setRenderHash(item.id, hash(body));
			return { issueNumber: link.githubIssueNumber };
		}

		if (item.destinationId) {
			const remote = await this.#github.commentBody(mappingKey, Number(item.destinationId));
			if (decideDiscordEdit(item.renderHash, hash(remote.body)) === "preserve-github") {
				await this.#recordConflict(mappingKey, link, item, hash(remote.body));
				return { commentId: Number(item.destinationId), conflict: true };
			}
			await this.#github.updateComment(mappingKey, Number(item.destinationId), body);
			await this.#relay.setRenderHash(item.id, hash(body));
			return { commentId: Number(item.destinationId) };
		}
		const comment = await this.#github.createComment({
			body,
			issueNumber: link.githubIssueNumber,
			mappingKey
		});
		await this.#relay.setDestination(item.id, String(comment.id));
		await this.#relay.setRenderHash(item.id, hash(body));
		return { commentId: comment.id, url: comment.url };
	}

	async #deleteGitHubItem(mappingKey: string, payload: JsonObject): Promise<JsonValue> {
		const item = await this.#requiredRelayItem(requiredString(payload, "relayItemId"));
		if (!item.destinationId) {
			await this.#relay.markDeleted(item.id);
			return { deleted: false };
		}
		try {
			await this.#github.deleteComment(mappingKey, Number(item.destinationId));
		} catch (error) {
			if (!(error instanceof RelayFailure && error.category === "not-found")) {
				throw error;
			}
		}
		await this.#relay.markDeleted(item.id);
		return { deleted: true };
	}

	async #syncGitHubLifecycle(mappingKey: string, payload: JsonObject): Promise<JsonValue> {
		const link = await this.#requiredLink(requiredNumber(payload, "linkId"));
		const action = requiredString(payload, "action");
		const actor = parseRelayAuthor(payload.actor);
		const attribution = actor
			? `Discord user **${actor.displayName}** (@\u200B${actor.username}, \`${actor.id}\`)`
			: "A Discord moderator";

		if (action === "close") {
			const configuredReason = optionalString(payload, "reason");
			const duplicateUrl = optionalString(payload, "duplicateUrl");
			const reason =
				configuredReason === "not_planned" ? "not planned" : configuredReason === "duplicate" ? "duplicate" : "completed";
			const duplicateIssue = duplicateUrl
				? await this.#github.currentIssue(mappingKey, issueNumberFromUrl(duplicateUrl))
				: undefined;
			await this.#github.createComment({
				body: duplicateUrl
					? `> ${attribution} marked this as a duplicate of [${issueReference(duplicateUrl)}](${duplicateUrl}).`
					: `> ${attribution} closed this from Discord as **${reason}**.`,
				issueNumber: link.githubIssueNumber,
				mappingKey
			});
			await this.#github.updateIssue(mappingKey, link.githubIssueNumber, {
				duplicateIssueId: duplicateIssue?.id,
				state: "closed",
				stateReason: reason === "not planned" ? "not_planned" : reason
			});
			await this.#relay.updateLinkState(link.id, "closed", link.locked);
		} else if (action === "reopen") {
			await this.#github.createComment({
				body: `> ${attribution} reopened this by posting in the Discord thread.`,
				issueNumber: link.githubIssueNumber,
				mappingKey
			});
			await this.#github.updateIssue(mappingKey, link.githubIssueNumber, {
				state: "open",
				stateReason: "reopened"
			});
			await this.#relay.updateLinkState(link.id, "open", link.locked);
		} else if (action === "lock") {
			await this.#github.createComment({
				body: `> ${attribution} locked this from Discord.`,
				issueNumber: link.githubIssueNumber,
				mappingKey
			});
			await this.#github.setLock(mappingKey, link.githubIssueNumber, true);
			await this.#relay.updateLinkState(link.id, link.state, true);
		} else if (action === "unlock") {
			await this.#github.setLock(mappingKey, link.githubIssueNumber, false);
			await this.#relay.updateLinkState(link.id, link.state, false);
		} else if (action === "rename") {
			const title = requiredString(payload, "title");
			await this.#github.updateIssue(mappingKey, link.githubIssueNumber, { title });
			await this.#relay.updateLinkTitle(link.id, title);
		} else if (action === "labels") {
			await this.#github.updateIssue(mappingKey, link.githubIssueNumber, {
				labels: stringArray(payload.labels)
			});
		}
		return { action, issueNumber: link.githubIssueNumber };
	}

	async #uploadAttachment(mappingKey: string, payload: JsonObject, correlationId: string): Promise<JsonValue> {
		const attachmentId = requiredString(payload, "attachmentId");
		const relayItemId = requiredString(payload, "relayItemId");
		const result = await this.#media.uploadAttachment(requiredString(payload, "sourceUrl"));
		await this.#relay.completeAttachment(attachmentId, result.hash, result.url);
		const item = await this.#requiredRelayItem(relayItemId);
		const link = await this.#requiredLink(item.issueThreadLinkId);
		await this.#jobs.enqueueOutbox({
			correlationId,
			idempotencyKey: `github:sync:${relayItemId}:attachment:${result.hash}`,
			mappingKey,
			operationKind: "github.item.sync",
			partitionKey: `link:${link.id}`,
			payload: { relayItemId },
			platform: "github",
			relayItemId
		});
		return { hash: result.hash, url: result.url };
	}

	async #recordConflict(mappingKey: string, link: IssueThreadLink, item: RelayItem, canonicalHash: string) {
		await this.#relay.saveRevisionShadow(item.id, item.sourceId, canonicalHash);
		if (link.discordThreadId) {
			await this.#discord.createMessage(mappingKey, link.discordThreadId, {
				components: [
					{
						type: 10,
						content:
							"Forum Relay kept the newer GitHub revision and saved this Discord edit as a revision shadow. " +
							"An administrator can inspect and restore it explicitly."
					}
				],
				username: "Forum Relay"
			});
		}
		this.#logger.warn("Discord edit conflicted with a newer GitHub revision.", {
			mappingKey,
			relayItemId: item.id,
			sourceId: item.sourceId
		});
	}

	async #persistAttachments(
		item: RelayItem,
		attachments: readonly { contentType?: string; filename: string; id: string; size: number; url: string }[]
	) {
		for (const attachment of attachments) {
			await this.#relay.upsertAttachment(item.id, attachment);
		}
		for (const attachment of await this.#relay.attachments(item.id)) {
			if (attachment.state !== "PENDING") {
				continue;
			}
			await this.#jobs.enqueueOutbox({
				correlationId: crypto.randomUUID(),
				idempotencyKey: `media:attachment:${attachment.sourceAttachmentId}:${hash(attachment.sourceUrl)}`,
				mappingKey: item.mappingKey,
				operationKind: "media.attachment.upload",
				partitionKey: `attachment:${attachment.id}`,
				payload: {
					attachmentId: attachment.id,
					relayItemId: item.id,
					sourceUrl: attachment.sourceUrl
				},
				platform: "media",
				relayItemId: item.id
			});
		}
	}

	async #queueAuditClassification(mappingKey: string, payload: JsonObject) {
		const threadId = requiredString(payload, "id");
		const now = Date.now();
		await this.#relay.enqueueAuditClassification(mappingKey, threadId, JSON.stringify(payload), now);
	}

	async #requiredRelayItem(id: string) {
		const item = await this.#relay.getRelayItem(id);
		if (!item) {
			throw new RelayFailure(`Relay item ${id} does not exist.`, "not-found", "RELAY_ITEM_NOT_FOUND");
		}
		return item;
	}

	async #requiredLink(id: number) {
		const link = await this.#relay.getLink(id);
		if (!link) {
			throw new RelayFailure(`Issue/thread link ${id} does not exist.`, "not-found", "LINK_NOT_FOUND");
		}
		return link;
	}
}

function parseGitHubIssue(payload: JsonObject): GitHubIssue {
	const issue = requiredObject(payload.issue, "issue");
	const state = requiredString(issue, "state");
	if (state !== "open" && state !== "closed") {
		throw new RelayFailure(`Invalid GitHub issue state ${state}.`, "invalid", "GITHUB_PAYLOAD");
	}
	return {
		author: parseGitHubActor(issue.user),
		body: optionalString(issue, "body") ?? "",
		htmlUrl: requiredString(issue, "html_url"),
		id: requiredNumber(issue, "id"),
		labels: objectArray(issue.labels).map((label) => requiredString(label, "name")),
		locked: issue.locked === true,
		nodeId: requiredString(issue, "node_id"),
		number: requiredNumber(issue, "number"),
		state,
		stateReason: optionalString(issue, "state_reason"),
		title: requiredString(issue, "title"),
		updatedAt: requiredString(issue, "updated_at")
	};
}

function parseGitHubComment(payload: JsonObject): GitHubComment {
	const comment = requiredObject(payload.comment, "comment");
	return {
		author: parseGitHubActor(comment.user),
		body: optionalString(comment, "body") ?? "",
		htmlUrl: requiredString(comment, "html_url"),
		id: requiredNumber(comment, "id"),
		nodeId: requiredString(comment, "node_id"),
		updatedAt: requiredString(comment, "updated_at")
	};
}

function parseGitHubActor(value: JsonValue | undefined): RelayAuthor {
	const user = requiredObject(value, "GitHub actor");
	const username = requiredString(user, "login");
	return {
		avatarUrl: optionalString(user, "avatar_url"),
		displayName: username,
		id: String(requiredNumber(user, "id")),
		username
	};
}

function parseRelayAuthor(value: JsonValue | undefined) {
	if (!value || !isJsonObject(value)) {
		return undefined;
	}
	const id = optionalString(value, "id");
	const username = optionalString(value, "username");
	const displayName = optionalString(value, "displayName");
	return id && username && displayName
		? {
				avatarUrl: optionalString(value, "avatarUrl"),
				displayName,
				id,
				username
			}
		: undefined;
}

function parsePendingClose(status: string) {
	if (!status.startsWith("PENDING_CLOSE:")) {
		return undefined;
	}
	try {
		const value: JsonValue = JSON.parse(decodeURIComponent(status.slice("PENDING_CLOSE:".length)));
		if (!isJsonObject(value)) {
			return undefined;
		}
		const actor = parseRelayAuthor(value.actor);
		const reason = optionalString(value, "reason");
		if (!actor || !reason) {
			return undefined;
		}
		return {
			actor,
			duplicateUrl: optionalString(value, "duplicateUrl"),
			reason
		};
	} catch {
		return undefined;
	}
}

function issueReference(url: string) {
	const number = new URL(url).pathname.match(/\/issues\/(\d+)\/?$/)?.[1];
	return number ? `#${number}` : "the linked issue";
}

function issueNumberFromUrl(url: string) {
	const number = new URL(url).pathname.match(/\/issues\/(\d+)\/?$/)?.[1];
	if (!number) {
		throw new RelayFailure("Duplicate target is not a GitHub issue URL.", "invalid", "DUPLICATE_TARGET_INVALID");
	}
	return Number(number);
}

export function formatGitHubCloseReason(reason: string | undefined, duplicateUrl?: string, discordThreadUrl?: string) {
	if (reason === "duplicate") {
		if (!duplicateUrl) {
			return "marked as duplicate";
		}
		const discordTarget = discordThreadUrl ? ` ([Discord thread](${discordThreadUrl}))` : "";
		return `marked as duplicate of [${issueReference(duplicateUrl)}](${duplicateUrl})${discordTarget}`;
	}
	return reason === "not_planned" ? "marked as not planned" : "marked as completed";
}

export function parseDiscordMessage(payload: JsonObject): DiscordMessage {
	const author = requiredObject(payload.author, "message author");
	const member = payload.member && isJsonObject(payload.member) ? payload.member : undefined;
	const id = requiredString(author, "id");
	const username = requiredString(author, "username");
	const avatarHash = optionalString(author, "avatar");
	// Accept the normalized aliases produced by pre-0.1.0 thread-create jobs so
	// an operation already persisted before the serialization fix can recover.
	const channelId = optionalString(payload, "channel_id") ?? optionalString(payload, "channelId");
	const revision =
		optionalString(payload, "edited_timestamp") ?? optionalString(payload, "timestamp") ?? optionalString(payload, "revision");
	if (!channelId) {
		throw new RelayFailure("Expected channel_id to be a string.", "invalid", "PAYLOAD_INVALID");
	}
	if (!revision) {
		throw new RelayFailure("Expected message timestamp to be a string.", "invalid", "PAYLOAD_INVALID");
	}
	return {
		attachments: objectArray(payload.attachments).map((attachment) => ({
			contentType: optionalString(attachment, "content_type") ?? optionalString(attachment, "contentType"),
			filename: requiredString(attachment, "filename"),
			id: requiredString(attachment, "id"),
			size: requiredNumber(attachment, "size"),
			url: requiredString(attachment, "url")
		})),
		author: {
			avatarUrl:
				optionalString(author, "avatarUrl") ??
				(avatarHash
					? `https://cdn.discordapp.com/avatars/${id}/${avatarHash}.${avatarHash.startsWith("a_") ? "gif" : "png"}`
					: undefined),
			displayName:
				optionalString(author, "displayName") ??
				(member && optionalString(member, "nick")) ??
				optionalString(author, "global_name") ??
				username,
			id,
			username
		},
		channelId,
		content: optionalString(payload, "content") ?? "",
		id: requiredString(payload, "id"),
		revision
	};
}

function repositoryUrl(payload: JsonObject) {
	const repository = requiredObject(payload.repository, "repository");
	return optionalString(repository, "html_url") ?? `https://github.com/${requiredString(repository, "full_name")}`;
}

function eventRevision(payload: JsonObject) {
	const issue = payload.issue && isJsonObject(payload.issue) ? payload.issue : undefined;
	return (issue && optionalString(issue, "updated_at")) ?? String(Date.now());
}

function isLiveIssueActivity(eventKind: string, payload: JsonObject) {
	const action = eventKind.slice("issues.".length);
	if (optionalString(payload, "action") !== action) {
		return false;
	}
	return !["closed", "deleted", "labeled", "locked", "opened", "reopened", "unlabeled", "unlocked"].includes(action);
}

export function shouldSuppressGitHubBodyEcho(
	hasDiscordOrigin: boolean,
	matchesStoredRender: boolean,
	eventKind: string,
	isLiveWebhook: boolean,
	isOwnBotEvent: boolean
) {
	return hasDiscordOrigin && (matchesStoredRender || eventKind === "issues.opened" || (isLiveWebhook && isOwnBotEvent));
}

export function discordSyncFingerprint(input: {
	body: string;
	jumpUrl: string;
	labels: readonly string[];
	repository: string;
	title: string;
}) {
	// Include renderer behavior so reconciliation can repair already-relayed
	// messages after a deployment changes their Components V2 representation.
	return hash(JSON.stringify({ ...input, renderVersion: DISCORD_RENDER_VERSION }));
}

interface ReconciliationDiscordState {
	archived: boolean;
	locked: boolean;
}

export function reconciliationLifecycleRepairs(
	issueState: "closed" | "open",
	issueLocked: boolean,
	previousIssueState: "closed" | "open",
	previousIssueLocked: boolean,
	discordState?: ReconciliationDiscordState
) {
	const actions: ("closed" | "locked" | "reopened" | "unlocked")[] = [];
	const discordStateMismatch =
		discordState &&
		(issueState === "closed" ? !discordState.archived : !issueLocked && (discordState.archived || discordState.locked));
	if (previousIssueState !== issueState || discordStateMismatch) {
		actions.push(issueState === "closed" ? "closed" : "reopened");
	}
	if (previousIssueLocked !== issueLocked || (discordState && discordState.locked !== issueLocked)) {
		actions.push(issueLocked ? "locked" : "unlocked");
	}
	return actions;
}

function reconciliationDiscordState(payload: JsonObject): ReconciliationDiscordState | undefined {
	const state = payload.forum_relay_reconciliation;
	if (!state || !isJsonObject(state)) {
		return undefined;
	}
	return {
		archived: state.discord_archived === true,
		locked: state.discord_locked === true
	};
}

export function shouldIgnoreUnlinkedGitHubIssue(
	hasDiscordThread: boolean,
	issueState: "closed" | "open",
	bootstrap: BootstrapConfig | undefined,
	currentIssueState = issueState
) {
	return (
		!hasDiscordThread && currentIssueState === "closed" && bootstrap?.source === "github" && bootstrap.issueFilter === "open-only"
	);
}

function relatedGitHubIssue(payload: JsonObject) {
	const action = optionalString(payload, "action") ?? "";
	const candidate = action.startsWith("parent_issue_")
		? payload.sub_issue
		: action.startsWith("sub_issue_")
			? payload.parent_issue
			: action.startsWith("blocked_by_")
				? payload.blocked_issue
				: payload.blocking_issue;
	return requiredObject(candidate, "issue relationship subject");
}

function requiredActivityKind(value: string | undefined) {
	if (!value) {
		throw new RelayFailure("Expected activityKind to be a string.", "invalid", "PAYLOAD_INVALID");
	}
	return value;
}

function escapeDiscordMarkdown(value: string) {
	return value.replace(/[\\`*_{}[\]()<>#+.!|~]/g, "\\$&");
}

function githubActorProfileUrl(value: JsonValue | undefined, username: string) {
	const actor = value && isJsonObject(value) ? value : undefined;
	return (actor && optionalString(actor, "html_url")) ?? `https://github.com/${encodeURIComponent(username)}`;
}

function isOwnGitHubBotEvent(client: GitHubClient, payload: JsonObject) {
	const sender = payload.sender && isJsonObject(payload.sender) ? payload.sender : undefined;
	const login = sender && optionalString(sender, "login");
	return login ? client.isOwnBotLogin(login) : false;
}

function emptyDiscordContext(guildId: string, threadId: string) {
	return { channels: {}, guildId, roles: {}, threadId, users: {} };
}

function renderAttachment(attachment: StoredAttachment) {
	return {
		contentType: attachment.contentType,
		filename: attachment.filename,
		proxyUrl: attachment.proxyUrl,
		size: attachment.size ?? 0,
		state:
			attachment.state === "COMPLETE"
				? ("complete" as const)
				: attachment.state === "FAILED"
					? ("failed" as const)
					: ("pending" as const),
		url: attachment.sourceUrl
	};
}

function requiredObject(value: JsonValue | undefined, label: string): JsonObject {
	if (!value || !isJsonObject(value)) {
		throw new RelayFailure(`Expected ${label} to be an object.`, "invalid", "PAYLOAD_INVALID");
	}
	return value;
}

function requiredString(value: JsonObject, key: string) {
	const result = jsonString(value, key);
	if (result === undefined) {
		throw new RelayFailure(`Expected ${key} to be a string.`, "invalid", "PAYLOAD_INVALID");
	}
	return result;
}

function optionalString(value: JsonObject, key: string) {
	const result = value[key];
	return typeof result === "string" ? result : undefined;
}

function requiredNumber(value: JsonObject, key: string) {
	const result = jsonNumber(value, key);
	if (result === undefined) {
		throw new RelayFailure(`Expected ${key} to be a number.`, "invalid", "PAYLOAD_INVALID");
	}
	return result;
}

function objectArray(value: JsonValue | undefined) {
	return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function stringArray(value: JsonValue | undefined) {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function jsonRoundTrip(value: object): JsonValue {
	const result: JsonValue = JSON.parse(JSON.stringify(value));
	return result;
}
