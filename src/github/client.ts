import type { Client } from "@libsql/client";
import { App } from "@octokit/app";
import type { NormalizedConfig } from "@/config/normalize.js";
import type { RuntimeEnvironment } from "@/core/environment.js";
import type { JsonObject, JsonValue } from "@/core/json.js";
import type { Logger } from "@/core/logger.js";
import { RelayFailure } from "@/jobs/retry-policy.js";
import { planLabelBindings, type RepositoryLabel, type StoredLabelBinding } from "@/labels/bindings.js";
import { parseRenderedHtmlMediaUrls } from "@/render/markdown.js";

const REQUIRED_WEBHOOK_EVENTS = ["issue_comment", "issue_dependencies", "issues", "label", "repository", "sub_issues"] as const;
const REQUIRED_REPOSITORY_PERMISSIONS = {
	contents: "read",
	issues: "write",
	metadata: "read"
} as const;
const WEBHOOK_REDELIVERY_COOLDOWN_MS = 15 * 60_000;

export interface GitHubRepositoryIdentity {
	id: number;
	installationId: number;
	name: string;
	owner: string;
	private: boolean;
}

export interface CreateIssueInput {
	body: string;
	labels: readonly string[];
	mappingKey: string;
	title: string;
}

export interface CreateCommentInput {
	body: string;
	issueNumber: number;
	mappingKey: string;
}

export interface GitHubBootstrapIssue {
	comments: JsonObject[];
	createdAt: string;
	id: number;
	payload: JsonObject;
	state: "closed" | "open";
}

export interface GitHubCurrentIssue {
	id: number;
	number: number;
	payload: JsonObject;
	state: "closed" | "open";
	url: string;
}

export interface GitHubWebhookInspection {
	configuredUrl: string;
	contentType: string;
	expectedUrl: string;
	missingEvents: string[];
	missingPermissions: string[];
}

interface ProjectV2NodeResponse {
	node: {
		title: string;
		url: string;
	} | null;
}

interface ProjectV2ItemNodeResponse {
	node: {
		project: {
			title: string;
			url: string;
		};
	} | null;
}

interface IssueDuplicateResponse {
	repository: {
		issue: {
			duplicateOf: {
				number: number;
				url: string;
			} | null;
		} | null;
	} | null;
}

interface CachedInstallationToken {
	expiresAt: number;
	token: string;
}

export class GitHubClient {
	readonly #app: App;
	readonly #config: NormalizedConfig;
	readonly #database: Pick<Client, "batch" | "execute">;
	readonly #logger: Logger;
	#botLogin?: string;
	readonly #installationTokens = new Map<string, CachedInstallationToken>();
	readonly #redeliveryAttempts = new Map<number, number>();
	readonly #repositoryCache = new Map<string, GitHubRepositoryIdentity>();

	public constructor(
		environment: RuntimeEnvironment,
		config: NormalizedConfig,
		database: Pick<Client, "batch" | "execute">,
		logger: Logger
	) {
		this.#app = new App({
			appId: environment.githubAppId,
			privateKey: environment.githubPrivateKey,
			webhooks: { secret: environment.githubWebhookSecret },
			log: {
				debug: (message) => logger.debug(message),
				info: (message) => logger.info(message),
				warn: (message) => logger.warn(message),
				error: (message) => logger.error(message)
			}
		});
		this.#config = config;
		this.#database = database;
		this.#logger = logger;
	}

	public async initializeMappings() {
		try {
			await this.inspectWebhookConfiguration();
		} catch (error) {
			this.#logger.warn("Could not inspect the GitHub App configuration.", {
				error: error instanceof Error ? error : String(error)
			});
		}

		const results = new Map<string, GitHubRepositoryIdentity | Error>();
		for (const [mappingKey, mapping] of Object.entries(this.#config.mappings)) {
			try {
				const installation = await this.#app.octokit.request("GET /repos/{owner}/{repo}/installation", {
					owner: mapping.repository.owner,
					repo: mapping.repository.name
				});
				const octokit = await this.#app.getInstallationOctokit(installation.data.id);
				const repository = await octokit.request("GET /repos/{owner}/{repo}", {
					owner: mapping.repository.owner,
					repo: mapping.repository.name
				});
				const identity: GitHubRepositoryIdentity = {
					id: normalizeGitHubId(repository.data.id),
					installationId: installation.data.id,
					name: repository.data.name,
					owner: repository.data.owner.login,
					private: repository.data.private
				};
				this.#repositoryCache.set(mappingKey, identity);
				await this.#database.execute({
					sql: `
						UPDATE mappings SET github_repository_id = ?, github_installation_id = ?,
							last_error_code = NULL, last_error_message = NULL, updated_at = ?
						WHERE key = ?
					`,
					args: [identity.id, identity.installationId, Date.now(), mappingKey]
				});
				results.set(mappingKey, identity);
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				await this.#markMappingFailure(mappingKey, "GITHUB_ACCESS", normalized.message);
				results.set(mappingKey, normalized);
			}
		}
		return results;
	}

	public async inspectWebhookConfiguration(): Promise<GitHubWebhookInspection> {
		const [app, webhook] = await Promise.all([
			this.#app.octokit.request("GET /app"),
			this.#app.octokit.request("GET /app/hook/config")
		]);
		if (!app.data) {
			throw new RelayFailure("GitHub returned an empty App response.", "temporary", "GITHUB_APP_EMPTY");
		}
		const configuredUrl = webhook.data.url ?? "";
		const contentType = webhook.data.content_type ?? "";
		const expectedUrl = new URL("/webhooks/github", this.#config.publicBaseUrl).toString();
		const subscribedEvents = new Set(app.data.events);
		this.#rememberBotLogin(app.data.slug ? `${app.data.slug}[bot]` : undefined);
		const expectedEvents = [
			...REQUIRED_WEBHOOK_EVENTS,
			...(app.data.permissions?.organization_projects ? (["projects_v2_item"] as const) : [])
		];
		const missingEvents = expectedEvents.filter((event) => !subscribedEvents.has(event));
		const missingPermissions = requiredPermissionMismatches(app.data.permissions ?? {});
		const inspection = {
			configuredUrl,
			contentType,
			expectedUrl,
			missingEvents: [...missingEvents],
			missingPermissions
		};

		if (configuredUrl !== expectedUrl || contentType !== "json" || missingEvents.length > 0 || missingPermissions.length > 0) {
			this.#logger.warn("GitHub App configuration does not match Forum Relay.", {
				configuredUrl,
				contentType,
				expectedUrl,
				missingEvents,
				missingPermissions
			});
		} else {
			this.#logger.info("Validated GitHub App permissions and webhook configuration.", {
				configuredUrl,
				events: expectedEvents
			});
		}
		return inspection;
	}

	public async createIssue(input: CreateIssueInput) {
		const { mapping, octokit } = await this.#installationClient(input.mappingKey);
		try {
			const response = await octokit.request("POST /repos/{owner}/{repo}/issues", {
				owner: mapping.repository.owner,
				repo: mapping.repository.name,
				title: input.title,
				body: input.body,
				labels: [...input.labels]
			});
			this.#rememberBotLogin(response.data.user?.login);
			return {
				id: normalizeGitHubId(response.data.id),
				nodeId: response.data.node_id,
				number: response.data.number,
				url: response.data.html_url
			};
		} catch (error) {
			if (error instanceof RelayFailure) {
				throw error;
			}
			throw classifyGitHubError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async syncLabels(mappingKey: string, seedLabelNames: readonly string[] = []) {
		const { mapping, octokit } = await this.#installationClient(mappingKey);
		const labels: RepositoryLabel[] = [];
		for (let page = 1; page <= 100; page += 1) {
			const response = await octokit.request("GET /repos/{owner}/{repo}/labels", {
				owner: mapping.repository.owner,
				repo: mapping.repository.name,
				page,
				per_page: 100
			});
			labels.push(...response.data.map((label) => ({ id: normalizeGitHubId(label.id), name: label.name })));
			if (response.data.length < 100) {
				break;
			}
		}
		const knownNames = new Set(labels.map((label) => label.name.toLocaleLowerCase("en-US")));
		for (const name of [...new Set(seedLabelNames.map((candidate) => candidate.trim()).filter(Boolean))].sort((left, right) =>
			left.localeCompare(right, "en-US", { sensitivity: "base" })
		)) {
			const normalizedName = name.toLocaleLowerCase("en-US");
			if (knownNames.has(normalizedName)) {
				continue;
			}
			const created = await octokit.request("POST /repos/{owner}/{repo}/labels", {
				owner: mapping.repository.owner,
				repo: mapping.repository.name,
				color: "6e7781",
				description: "Imported from a Discord forum tag by Forum Relay.",
				name
			});
			labels.push({ id: normalizeGitHubId(created.data.id), name: created.data.name });
			knownNames.add(normalizedName);
		}

		const storedResult = await this.#database.execute({
			sql: `
				SELECT configured_github_name, configured_discord_name, github_label_id,
					discord_tag_id, discord_current_name
				FROM label_bindings WHERE mapping_key = ?
			`,
			args: [mappingKey]
		});
		const stored: StoredLabelBinding[] = storedResult.rows.map((row) => ({
			configuredDiscordName: String(row.configured_discord_name),
			configuredGithubName: String(row.configured_github_name),
			discordCurrentName: typeof row.discord_current_name === "string" ? row.discord_current_name : undefined,
			discordTagId: typeof row.discord_tag_id === "string" ? row.discord_tag_id : undefined,
			githubLabelId: typeof row.github_label_id === "number" ? row.github_label_id : undefined
		}));
		const planned = planLabelBindings(labels, stored);
		const now = Date.now();
		await this.#database.batch(
			[
				{
					sql: "DELETE FROM label_bindings WHERE mapping_key = ?",
					args: [mappingKey]
				},
				...planned.map((binding) => ({
					sql: `
						INSERT INTO label_bindings (
							mapping_key, position, configured_github_name, configured_discord_name,
							github_label_id, github_current_name, discord_tag_id, discord_current_name,
							state, created_at, updated_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					`,
					args: [
						mappingKey,
						binding.position,
						binding.configuredGithubName,
						binding.configuredDiscordName,
						binding.githubLabelId,
						binding.configuredGithubName,
						binding.discordTagId ?? null,
						binding.discordCurrentName ?? null,
						binding.state,
						now,
						now
					]
				}))
			],
			"write"
		);
		this.#logger.info("Discovered GitHub label definitions.", {
			count: labels.length,
			mappingKey
		});
	}

	public async bootstrapIssues(mappingKey: string): Promise<GitHubBootstrapIssue[]> {
		const { mapping, octokit } = await this.#installationClient(mappingKey);
		const issues = [];
		for (let page = 1; ; page += 1) {
			const response = await octokit.request("GET /repos/{owner}/{repo}/issues", {
				owner: mapping.repository.owner,
				repo: mapping.repository.name,
				direction: "asc",
				page,
				per_page: 100,
				sort: "created",
				state: "all"
			});
			for (const issue of response.data) {
				if ("pull_request" in issue) {
					continue;
				}
				const comments = [];
				for (let commentsPage = 1; ; commentsPage += 1) {
					const commentResponse = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
						owner: mapping.repository.owner,
						repo: mapping.repository.name,
						issue_number: issue.number,
						page: commentsPage,
						per_page: 100
					});
					comments.push(...commentResponse.data.map((comment) => commentPayload(issue, comment, mapping)));
					if (commentResponse.data.length < 100) {
						break;
					}
				}
				issues.push({
					comments,
					createdAt: issue.created_at,
					id: normalizeGitHubId(issue.id),
					payload: issuePayload(issue, mapping),
					state: issue.state === "closed" ? "closed" : "open"
				} satisfies GitHubBootstrapIssue);
			}
			if (response.data.length < 100) {
				break;
			}
		}
		return issues;
	}

	public async redeliverFailedWebhooks(now = Date.now()) {
		let requested = 0;
		let cursor: string | undefined;
		for (let inspectedPages = 0; inspectedPages < 10; inspectedPages += 1) {
			const response = await this.#app.octokit.request(
				"GET /app/hook/deliveries",
				cursor ? { cursor, per_page: 100 } : { per_page: 100 }
			);
			for (const delivery of response.data) {
				const deliveryId = normalizeGitHubId(delivery.id);
				const previousAttempt = this.#redeliveryAttempts.get(deliveryId);
				if (
					delivery.redelivery ||
					(delivery.status_code >= 200 && delivery.status_code < 300) ||
					(previousAttempt !== undefined && now - previousAttempt < WEBHOOK_REDELIVERY_COOLDOWN_MS)
				) {
					continue;
				}
				await this.#app.octokit.request("POST /app/hook/deliveries/{delivery_id}/attempts", {
					delivery_id: deliveryId
				});
				this.#redeliveryAttempts.set(deliveryId, now);
				requested += 1;
			}

			// Unlike most REST endpoints, App webhook deliveries expose an opaque cursor in Link.
			cursor = nextCursor(response.headers.link);
			if (!cursor) {
				break;
			}
		}
		return requested;
	}

	public async createComment(input: CreateCommentInput) {
		const { mapping, octokit } = await this.#installationClient(input.mappingKey);
		try {
			const response = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
				owner: mapping.repository.owner,
				repo: mapping.repository.name,
				issue_number: input.issueNumber,
				body: input.body
			});
			this.#rememberBotLogin(response.data.user?.login);
			return { id: normalizeGitHubId(response.data.id), nodeId: response.data.node_id, url: response.data.html_url };
		} catch (error) {
			throw classifyGitHubError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async projectV2(mappingKey: string, projectNodeId: string) {
		const { octokit } = await this.#installationClient(mappingKey);
		try {
			const response = await octokit.graphql<ProjectV2NodeResponse>(
				`
					query ForumRelayProject($id: ID!) {
						node(id: $id) {
							... on ProjectV2 {
								title
								url
							}
						}
					}
				`,
				{ id: projectNodeId }
			);
			return response.node ?? undefined;
		} catch (error) {
			throw classifyGitHubError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async projectV2ForItem(mappingKey: string, itemNodeId: string) {
		const { octokit } = await this.#installationClient(mappingKey);
		try {
			const response = await octokit.graphql<ProjectV2ItemNodeResponse>(
				`
					query ForumRelayProjectItem($id: ID!) {
						node(id: $id) {
							... on ProjectV2Item {
								project {
									title
									url
								}
							}
						}
					}
				`,
				{ id: itemNodeId }
			);
			return response.node?.project;
		} catch (error) {
			throw classifyGitHubError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public isOwnBotLogin(login: string) {
		return this.#botLogin?.toLocaleLowerCase("en-US") === login.toLocaleLowerCase("en-US");
	}

	public async mediaAuthorization(mappingKey: string) {
		const cached = this.#installationTokens.get(mappingKey);
		if (cached && cached.expiresAt - Date.now() > 5 * 60_000) {
			return `Bearer ${cached.token}`;
		}

		const repository = this.#repositoryCache.get(mappingKey);
		if (!repository) {
			throw new RelayFailure(`Mapping "${mappingKey}" has no GitHub installation.`, "authentication", "INSTALLATION_MISSING");
		}
		try {
			const response = await this.#app.octokit.request("POST /app/installations/{installation_id}/access_tokens", {
				installation_id: repository.installationId
			});
			if (!permissionSatisfies(response.data.permissions?.contents, "read")) {
				throw new RelayFailure(
					"The GitHub App installation has not granted Contents: read, which is required to relay issue attachments.",
					"authentication",
					"GITHUB_CONTENTS_PERMISSION"
				);
			}
			this.#installationTokens.set(mappingKey, {
				expiresAt: Date.parse(response.data.expires_at),
				token: response.data.token
			});
			return `Bearer ${response.data.token}`;
		} catch (error) {
			if (error instanceof RelayFailure) {
				throw error;
			}
			throw classifyGitHubError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async renderedMediaUrls(mappingKey: string, markdown: string) {
		const { mapping, octokit } = await this.#installationClient(mappingKey);
		try {
			// The raw issue body only contains github.com/user-attachments URLs.
			// GitHub's renderer exchanges those for short-lived, downloadable URLs
			// scoped to the authenticated repository installation.
			const response = await octokit.request("POST /markdown", {
				context: `${mapping.repository.owner}/${mapping.repository.name}`,
				mode: "gfm",
				text: markdown
			});
			return parseRenderedHtmlMediaUrls(response.data);
		} catch (error) {
			throw classifyGitHubError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async updateIssue(
		mappingKey: string,
		issueNumber: number,
		changes: {
			body?: string;
			duplicateIssueId?: number;
			labels?: readonly string[];
			state?: "closed" | "open";
			stateReason?: "completed" | "duplicate" | "not_planned" | "reopened";
			title?: string;
		}
	) {
		const { mapping, octokit } = await this.#installationClient(mappingKey);
		try {
			const { duplicateIssueId, stateReason, ...issueChanges } = changes;
			const response = await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
				owner: mapping.repository.owner,
				repo: mapping.repository.name,
				issue_number: issueNumber,
				...issueChanges,
				duplicate_issue_id: duplicateIssueId,
				labels: changes.labels ? [...changes.labels] : undefined,
				state_reason: stateReason
			});
			return { id: normalizeGitHubId(response.data.id), updatedAt: response.data.updated_at };
		} catch (error) {
			throw classifyGitHubError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async updateComment(mappingKey: string, commentId: number, body: string) {
		const { mapping, octokit } = await this.#installationClient(mappingKey);
		try {
			await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
				owner: mapping.repository.owner,
				repo: mapping.repository.name,
				comment_id: commentId,
				body
			});
			return { id: commentId };
		} catch (error) {
			throw classifyGitHubError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async issueBody(mappingKey: string, issueNumber: number) {
		const { mapping, octokit } = await this.#installationClient(mappingKey);
		const response = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
			owner: mapping.repository.owner,
			repo: mapping.repository.name,
			issue_number: issueNumber
		});
		return { body: response.data.body ?? "", updatedAt: response.data.updated_at };
	}

	public async currentIssue(mappingKey: string, issueNumber: number): Promise<GitHubCurrentIssue> {
		const { mapping, octokit } = await this.#installationClient(mappingKey);
		try {
			const response = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
				owner: mapping.repository.owner,
				repo: mapping.repository.name,
				issue_number: issueNumber
			});
			return {
				id: normalizeGitHubId(response.data.id),
				number: response.data.number,
				payload: issuePayload(response.data, mapping),
				state: response.data.state === "closed" ? "closed" : "open",
				url: response.data.html_url
			};
		} catch (error) {
			throw classifyGitHubError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async duplicateOf(mappingKey: string, issueNumber: number) {
		const { mapping, octokit } = await this.#installationClient(mappingKey);
		try {
			const response = await octokit.graphql<IssueDuplicateResponse>(
				`
					query ForumRelayIssueDuplicate($owner: String!, $repository: String!, $number: Int!) {
						repository(owner: $owner, name: $repository) {
							issue(number: $number) {
								duplicateOf {
									number
									url
								}
							}
						}
					}
				`,
				{
					number: issueNumber,
					owner: mapping.repository.owner,
					repository: mapping.repository.name
				}
			);
			return response.repository?.issue?.duplicateOf ?? undefined;
		} catch (error) {
			throw classifyGitHubError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async commentBody(mappingKey: string, commentId: number) {
		const { mapping, octokit } = await this.#installationClient(mappingKey);
		const response = await octokit.request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
			owner: mapping.repository.owner,
			repo: mapping.repository.name,
			comment_id: commentId
		});
		return { body: response.data.body ?? "", updatedAt: response.data.updated_at };
	}

	public async deleteComment(mappingKey: string, commentId: number) {
		const { mapping, octokit } = await this.#installationClient(mappingKey);
		try {
			await octokit.request("DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}", {
				owner: mapping.repository.owner,
				repo: mapping.repository.name,
				comment_id: commentId
			});
			return { id: commentId };
		} catch (error) {
			throw classifyGitHubError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	public async setLock(
		mappingKey: string,
		issueNumber: number,
		locked: boolean,
		reason?: "off-topic" | "resolved" | "spam" | "too heated"
	) {
		const { mapping, octokit } = await this.#installationClient(mappingKey);
		try {
			if (locked) {
				await octokit.request("PUT /repos/{owner}/{repo}/issues/{issue_number}/lock", {
					owner: mapping.repository.owner,
					repo: mapping.repository.name,
					issue_number: issueNumber,
					lock_reason: reason
				});
			} else {
				await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/lock", {
					owner: mapping.repository.owner,
					repo: mapping.repository.name,
					issue_number: issueNumber
				});
			}
			return { issueNumber, locked };
		} catch (error) {
			throw classifyGitHubError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	async #installationClient(mappingKey: string) {
		const mapping = this.#config.mappings[mappingKey];
		if (!mapping) {
			throw new RelayFailure(`Mapping "${mappingKey}" is not configured.`, "invalid", "MAPPING_NOT_FOUND");
		}
		const repository = this.#repositoryCache.get(mappingKey);
		if (!repository) {
			throw new RelayFailure(`Mapping "${mappingKey}" has no GitHub installation.`, "authentication", "INSTALLATION_MISSING");
		}
		return {
			mapping,
			octokit: await this.#app.getInstallationOctokit(repository.installationId)
		};
	}

	#rememberBotLogin(login: string | undefined) {
		if (login?.endsWith("[bot]")) {
			this.#botLogin = login;
		}
	}

	async #markMappingFailure(mappingKey: string, code: string, message: string) {
		this.#logger.warn("GitHub mapping validation failed.", { mappingKey, errorCode: code, message });
		await this.#database.execute({
			sql: `
				UPDATE mappings SET state = 'DEGRADED', last_error_code = ?,
					last_error_message = ?, updated_at = ? WHERE key = ?
			`,
			args: [code, message, Date.now(), mappingKey]
		});
	}
}

function requiredPermissionMismatches(permissions: Record<string, string | undefined>) {
	return Object.entries(REQUIRED_REPOSITORY_PERMISSIONS)
		.filter(([name, required]) => !permissionSatisfies(permissions[name], required))
		.map(([name, required]) => `${name}:${required}`);
}

function permissionSatisfies(actual: string | undefined, required: "read" | "write") {
	return actual === required || (required === "read" && actual === "write");
}

function nextCursor(linkHeader: string | undefined) {
	if (!linkHeader) {
		return undefined;
	}

	for (const link of linkHeader.split(",")) {
		const match = link.match(/<([^>]+)>\s*;\s*rel="next"/);
		if (!match?.[1]) {
			continue;
		}

		try {
			return new URL(match[1]).searchParams.get("cursor") || undefined;
		} catch {
			return undefined;
		}
	}

	return undefined;
}

function classifyGitHubError(error: Error) {
	const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
	const retryAfter =
		"response" in error && error.response !== null && typeof error.response === "object"
			? retryAfterFromResponse(error.response)
			: undefined;

	if (status === 401 || status === 403) {
		return new RelayFailure(error.message, "authentication", `GITHUB_${status}`);
	}
	if (status === 404) {
		return new RelayFailure(error.message, "not-found", "GITHUB_404");
	}
	if (status === 409 || status === 422) {
		return new RelayFailure(error.message, "conflict", `GITHUB_${status}`);
	}
	if (status === 429 || retryAfter !== undefined) {
		return new RelayFailure(error.message, "rate-limit", "GITHUB_RATE_LIMIT", retryAfter);
	}
	return new RelayFailure(error.message, "temporary", status ? `GITHUB_${status}` : "GITHUB_NETWORK");
}

function retryAfterFromResponse(value: object) {
	if (!("headers" in value) || !value.headers || typeof value.headers !== "object") {
		return undefined;
	}
	const headers = value.headers;
	if (!("retry-after" in headers) || typeof headers["retry-after"] !== "string") {
		return undefined;
	}
	const seconds = Number(headers["retry-after"]);
	return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
}

function issuePayload(
	issue: {
		body?: string | null;
		closed_by?: { avatar_url: string; id: number | bigint; login: string } | null;
		html_url: string;
		id: number | bigint;
		labels: (string | { name?: string })[];
		locked: boolean;
		node_id: string;
		number: number;
		state: string;
		state_reason?: string | null;
		title: string;
		updated_at: string;
		user: { avatar_url: string; id: number | bigint; login: string } | null;
	},
	mapping: NormalizedConfig["mappings"][string]
): JsonObject {
	const user = actorPayload(issue.user);
	const sender = issue.state === "closed" ? actorPayload(issue.closed_by ?? issue.user) : user;
	return {
		action: "opened",
		issue: {
			body: issue.body ?? "",
			html_url: issue.html_url,
			id: normalizeGitHubId(issue.id),
			labels: issue.labels
				.map((label) => (typeof label === "string" ? label : label.name))
				.filter((name): name is string => typeof name === "string")
				.map((name) => ({ name })),
			locked: issue.locked,
			node_id: issue.node_id,
			number: issue.number,
			state: issue.state,
			state_reason: issue.state_reason ?? null,
			title: issue.title,
			updated_at: issue.updated_at,
			user
		},
		repository: {
			full_name: `${mapping.repository.owner}/${mapping.repository.name}`,
			html_url: `https://github.com/${mapping.repository.owner}/${mapping.repository.name}`,
			id: 0
		},
		sender
	};
}

function commentPayload(
	issue: Parameters<typeof issuePayload>[0],
	comment: {
		body?: string;
		html_url: string;
		id: number | bigint;
		node_id: string;
		updated_at: string;
		user: { avatar_url: string; id: number | bigint; login: string } | null;
	},
	mapping: NormalizedConfig["mappings"][string]
): JsonObject {
	return {
		...issuePayload(issue, mapping),
		action: "created",
		comment: {
			body: comment.body ?? "",
			html_url: comment.html_url,
			id: normalizeGitHubId(comment.id),
			node_id: comment.node_id,
			updated_at: comment.updated_at,
			user: actorPayload(comment.user)
		}
	};
}

function actorPayload(user: { avatar_url: string; id: number | bigint; login: string } | null): JsonValue {
	return user
		? { avatar_url: user.avatar_url, id: normalizeGitHubId(user.id), login: user.login }
		: { avatar_url: "", id: 0, login: "ghost" };
}

/**
 * GitHub's generated REST types allow bigint IDs, while the current schema stores safe JavaScript integers.
 * Normalize at the adapter boundary so an eventual oversized ID fails explicitly instead of being rounded.
 */
export function normalizeGitHubId(value: number | bigint) {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized) || normalized <= 0) {
		throw new RelayFailure(`GitHub returned an unsupported numeric ID: ${value}.`, "invalid", "GITHUB_ID_UNSAFE");
	}
	return normalized;
}
