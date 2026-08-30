import type { JsonObject, JsonValue } from "@/core/json.js";
import { isJsonObject, jsonString } from "@/core/json.js";
import type { RelayAuthor } from "@/db/relay-repository.js";

export interface GitHubProjectSummary {
	title: string;
	url: string;
}

export interface GitHubActivityRender {
	author: RelayAuthor;
	content: string;
}

export function renderGitHubActivity(
	eventKind: string,
	payload: JsonObject,
	project?: GitHubProjectSummary
): GitHubActivityRender | undefined {
	const author = githubActor(payload.sender);
	if (!author) {
		return undefined;
	}

	const actor = githubUserLink(author.username, stringValue(objectValue(payload.sender)?.html_url));
	const action = eventKind.split(".").at(-1) ?? eventKind;
	const issue = objectValue(payload.issue);
	let description: string | undefined;

	if (eventKind.startsWith("projects_v2_item.")) {
		description = projectActivity(action, payload, project);
	} else if (eventKind.startsWith("sub_issues.")) {
		description = relatedIssueActivity(action, payload, "sub-issue");
	} else if (eventKind.startsWith("issue_dependencies.")) {
		description = relatedIssueActivity(action, payload, "dependency");
	} else {
		description = issueActivity(action, payload, issue);
	}

	return description ? { author, content: `> ${actor} ${description}` } : undefined;
}

export function githubUserLink(username: string, profileUrl = `https://github.com/${encodeURIComponent(username)}`) {
	// GitHub logins contain only safe URL-label characters, plus GitHub's
	// balanced "[bot]" suffix. Escaping them is visibly rendered by Discord.
	return `[${username}](${profileUrl})`;
}

function issueActivity(action: string, payload: JsonObject, issue: JsonObject | undefined) {
	switch (action) {
		case "assigned":
			return `assigned ${linkedUser(payload.assignee) ?? "someone"} on GitHub`;
		case "unassigned":
			return `unassigned ${linkedUser(payload.assignee) ?? "someone"} on GitHub`;
		case "labeled":
			return `added the ${inlineCode(namedValue(payload.label) ?? "unknown")} label on GitHub`;
		case "unlabeled":
			return `removed the ${inlineCode(namedValue(payload.label) ?? "unknown")} label on GitHub`;
		case "milestoned":
			return `added this to ${linkedNamedValue(payload.milestone, "a milestone")} on GitHub`;
		case "demilestoned":
			return `removed this from ${linkedNamedValue(payload.milestone, "a milestone")} on GitHub`;
		case "pinned":
			return "pinned this issue on GitHub";
		case "unpinned":
			return "unpinned this issue on GitHub";
		case "typed":
			return `added the ${inlineCode(namedValue(payload.type) ?? "unknown")} issue type on GitHub`;
		case "untyped":
			return `removed the ${inlineCode(namedValue(payload.type) ?? "unknown")} issue type on GitHub`;
		case "reopened":
			return "reopened this issue on GitHub";
		case "unlocked":
			return "unlocked this issue on GitHub";
		case "transferred":
			return `transferred this issue to ${linkedNamedValue(issue, "another repository")} on GitHub`;
		case "edited":
			return editedIssueActivity(payload, issue);
		case "deleted":
		case "opened":
		case "closed":
		case "locked":
			return undefined;
		default:
			return `${humanize(action)} this issue on GitHub`;
	}
}

function editedIssueActivity(payload: JsonObject, issue: JsonObject | undefined) {
	const changes = objectValue(payload.changes);
	const titleChange = objectValue(changes?.title);
	const previousTitle = stringValue(titleChange?.from);
	const currentTitle = stringValue(issue?.title);
	if (previousTitle && currentTitle && previousTitle !== currentTitle) {
		return `changed the title on GitHub\n> ~~${escapeMarkdown(previousTitle)}~~\n> **${escapeMarkdown(currentTitle)}**`;
	}

	// GitHub does not show ordinary body edits as separate timeline rows, so do
	// not add noisy activity messages for edits already reflected in the starter.
	return undefined;
}

function projectActivity(action: string, payload: JsonObject, project?: GitHubProjectSummary) {
	const target = project ? `[${escapeMarkdown(project.title)}](${project.url})` : "a GitHub Project";
	const changes = objectValue(payload.changes);
	const fieldChange = objectValue(changes?.field_value);
	const fieldName = stringValue(fieldChange?.field_name);
	const from = projectFieldValue(fieldChange?.from);
	const to = projectFieldValue(fieldChange?.to);

	switch (action) {
		case "created":
			return `added this to ${target} on GitHub`;
		case "deleted":
			return `removed this from ${target} on GitHub`;
		case "archived":
			return `archived this in ${target} on GitHub`;
		case "restored":
			return `restored this in ${target} on GitHub`;
		case "reordered":
			return `reordered this in ${target} on GitHub`;
		case "edited":
			if (fieldName?.toLocaleLowerCase("en-US") === "status" && to) {
				return `moved this${from ? ` from ${inlineCode(from)}` : ""} to ${inlineCode(to)} in ${target} on GitHub`;
			}
			if (fieldName) {
				return `changed ${inlineCode(fieldName)}${from ? ` from ${inlineCode(from)}` : ""}${
					to ? ` to ${inlineCode(to)}` : ""
				} in ${target} on GitHub`;
			}
			return `updated this in ${target} on GitHub`;
		case "converted":
			return `converted this from a draft item in ${target} on GitHub`;
		default:
			return `${humanize(action)} this in ${target} on GitHub`;
	}
}

function relatedIssueActivity(action: string, payload: JsonObject, relationship: string) {
	const related = action.startsWith("parent_issue_")
		? payload.parent_issue
		: action.startsWith("sub_issue_")
			? payload.sub_issue
			: action.startsWith("blocked_by_")
				? payload.blocking_issue
				: payload.blocked_issue;
	const target = linkedNamedValue(related, `a ${relationship}`);
	if (action.endsWith("_added") || action === "added") {
		return `added ${target} on GitHub`;
	}
	if (action.endsWith("_removed") || action === "removed") {
		return `removed ${target} on GitHub`;
	}
	return `${humanize(action)} ${target} on GitHub`;
}

function githubActor(value: JsonValue | undefined): RelayAuthor | undefined {
	const actor = objectValue(value);
	const username = stringValue(actor?.login);
	const id = numberValue(actor?.id);
	if (!username || id === undefined) {
		return undefined;
	}
	return {
		avatarUrl: stringValue(actor?.avatar_url),
		displayName: username,
		id: String(id),
		username
	};
}

function linkedUser(value: JsonValue | undefined) {
	const user = objectValue(value);
	const username = stringValue(user?.login);
	return username ? githubUserLink(username, stringValue(user?.html_url)) : undefined;
}

function linkedNamedValue(value: JsonValue | undefined, fallback: string) {
	const object = objectValue(value);
	if (!object) {
		return fallback;
	}
	const name = namedValue(object) ?? fallback;
	const url = stringValue(object.html_url);
	return url ? `[${escapeMarkdown(name)}](${url})` : inlineCode(name);
}

function namedValue(value: JsonValue | undefined) {
	const object = objectValue(value);
	return stringValue(object?.name) ?? stringValue(object?.title) ?? issueReference(object);
}

function issueReference(value: JsonObject | undefined) {
	const number = numberValue(value?.number);
	return number === undefined ? undefined : `#${number}`;
}

function projectFieldValue(value: JsonValue | undefined): string | undefined {
	if (typeof value === "string" || typeof value === "number") {
		return String(value);
	}
	if (!value || !isJsonObject(value)) {
		return undefined;
	}
	return jsonString(value, "name") ?? jsonString(value, "title");
}

function objectValue(value: JsonValue | undefined) {
	return value && isJsonObject(value) ? value : undefined;
}

function stringValue(value: JsonValue | undefined) {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: JsonValue | undefined) {
	return typeof value === "number" ? value : undefined;
}

function inlineCode(value: string) {
	return `\`${value.replaceAll("`", "'")}\``;
}

function humanize(value: string) {
	return value.replaceAll("_", " ");
}

function escapeMarkdown(value: string) {
	return value.replace(/[\\`*_{}[\]()<>#+.!|~]/g, "\\$&");
}
