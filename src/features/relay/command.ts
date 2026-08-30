import type { Row } from "@libsql/client";
import {
	type APIApplicationCommandInteractionDataOption,
	type APIChatInputApplicationCommandInteraction,
	ApplicationCommandOptionType,
	ApplicationCommandType,
	PermissionFlagsBits
} from "discord-api-types/v10";
import { defineCommand } from "@/core/defineCommand.js";
import { deferEphemeral, editEphemeralResponse, respondEphemeral } from "@/core/respond.js";
import type { BotApp } from "@/core/types.js";

const mappingOption = {
	name: "mapping",
	description: "Configured mapping key.",
	required: true,
	type: ApplicationCommandOptionType.String
} as const;

export default defineCommand({
	data: {
		name: "relay",
		description: "Inspect and administer Forum Relay.",
		type: ApplicationCommandType.ChatInput,
		options: [
			{
				name: "status",
				description: "Show the configured relay mappings.",
				type: ApplicationCommandOptionType.Subcommand
			},
			{
				name: "doctor",
				description: "Check persisted mapping state and failed work.",
				type: ApplicationCommandOptionType.Subcommand,
				options: [
					{
						...mappingOption,
						required: false
					}
				]
			},
			{
				name: "close",
				description: "Close the linked GitHub issue from this forum thread.",
				type: ApplicationCommandOptionType.Subcommand,
				options: [
					{
						name: "reason",
						description: "GitHub close reason.",
						required: true,
						type: ApplicationCommandOptionType.String,
						choices: [
							{ name: "Completed", value: "completed" },
							{ name: "Not planned", value: "not-planned" },
							{ name: "Duplicate", value: "duplicate" }
						]
					},
					{
						name: "duplicate",
						description: "For duplicates: same-repository issue number/URL or mapped Discord thread.",
						required: false,
						type: ApplicationCommandOptionType.String
					}
				]
			},
			{
				name: "pause",
				description: "Pause live work for one mapping.",
				type: ApplicationCommandOptionType.Subcommand,
				options: [mappingOption]
			},
			{
				name: "resume",
				description: "Resume live work for one bootstrapped mapping.",
				type: ApplicationCommandOptionType.Subcommand,
				options: [mappingOption]
			},
			{
				name: "bootstrap",
				description: "Preview and control the first historical import.",
				type: ApplicationCommandOptionType.SubcommandGroup,
				options: [
					{
						name: "preview",
						description: "Inspect both platforms without changing content.",
						type: ApplicationCommandOptionType.Subcommand,
						options: [mappingOption]
					},
					{
						name: "start",
						description: "Start the previously configured bootstrap direction.",
						type: ApplicationCommandOptionType.Subcommand,
						options: [mappingOption]
					},
					{
						name: "pause",
						description: "Pause a running bootstrap safely.",
						type: ApplicationCommandOptionType.Subcommand,
						options: [mappingOption]
					},
					{
						name: "resume",
						description: "Resume a paused or failed bootstrap.",
						type: ApplicationCommandOptionType.Subcommand,
						options: [mappingOption]
					}
				]
			},
			{
				name: "reconcile",
				description: "Preview or run repair reconciliation.",
				type: ApplicationCommandOptionType.SubcommandGroup,
				options: [
					{
						name: "preview",
						description: "Compare both platforms without scheduling repairs.",
						type: ApplicationCommandOptionType.Subcommand,
						options: [mappingOption]
					},
					{
						name: "start",
						description: "Schedule safe repairs for a mapping.",
						type: ApplicationCommandOptionType.Subcommand,
						options: [mappingOption]
					}
				]
			},
			{
				name: "failures",
				description: "Inspect and control dead-letter work.",
				type: ApplicationCommandOptionType.SubcommandGroup,
				options: [
					{
						name: "list",
						description: "List recent failed inbox/outbox work.",
						type: ApplicationCommandOptionType.Subcommand,
						options: [{ ...mappingOption, required: false }]
					},
					{
						name: "retry",
						description: "Retry one failed event or operation by ID.",
						type: ApplicationCommandOptionType.Subcommand,
						options: [
							{
								name: "id",
								description: "Inbox event or outbox operation ID.",
								required: true,
								type: ApplicationCommandOptionType.String
							}
						]
					},
					{
						name: "discard",
						description: "Permanently discard one failed event or operation.",
						type: ApplicationCommandOptionType.Subcommand,
						options: [
							{
								name: "id",
								description: "Inbox event or outbox operation ID.",
								required: true,
								type: ApplicationCommandOptionType.String
							}
						]
					}
				]
			}
		]
	},
	async execute(app, interaction) {
		const selection = selectedOperation(interaction.data.options ?? []);
		if (selection.operation === "status") {
			await respondEphemeral(app, interaction, { content: await statusText(app) });
			return;
		}
		if (selection.operation === "close") {
			try {
				await closeFromDiscord(app, interaction, selection.reason, selection.duplicateTarget);
			} catch (error) {
				await respondEphemeral(app, interaction, {
					content: error instanceof Error ? error.message : "The close operation failed."
				});
			}
			return;
		}

		if (!isAdministrator(app, interaction.member)) {
			await respondEphemeral(app, interaction, {
				content: "You must be the configured owner or a Forum Relay administrator to use this operation."
			});
			return;
		}

		if (selection.operation === "doctor") {
			await respondEphemeral(app, interaction, { content: await doctorText(app, selection.mappingKey) });
			return;
		}
		if (selection.operation === "failures.list") {
			await respondEphemeral(app, interaction, {
				content: await failuresText(app, selection.mappingKey)
			});
			return;
		}
		if (selection.operation === "failures.retry" || selection.operation === "failures.discard") {
			await mutateFailure(app, selection.failureId, selection.operation === "failures.retry" ? "retry" : "discard");
			await respondEphemeral(app, interaction, {
				content: `${selection.operation === "failures.retry" ? "Queued" : "Discarded"} failure \`${selection.failureId}\`.`
			});
			return;
		}

		if (!selection.mappingKey) {
			await respondEphemeral(app, interaction, { content: "A mapping key is required." });
			return;
		}

		// Bootstrap previews inventory both remote platforms and routinely exceed
		// Discord's three-second initial interaction response window.
		await deferEphemeral(app, interaction);
		try {
			if (selection.operation === "bootstrap.preview") {
				const preview = await app.bootstrap.preview(selection.mappingKey);
				await editEphemeralResponse(app, interaction, { content: formatPreview(preview) });
			} else if (selection.operation === "bootstrap.start") {
				const started = await app.bootstrap.start(selection.mappingKey, interaction.member?.user.id ?? app.config.ownerId);
				await editEphemeralResponse(app, interaction, {
					content: `Bootstrap \`${started.jobId}\` started.\n\n${formatPreview(started.preview)}`
				});
			} else if (selection.operation === "bootstrap.pause") {
				await app.bootstrap.pause(selection.mappingKey);
				await editEphemeralResponse(app, interaction, { content: `Paused bootstrap for \`${selection.mappingKey}\`.` });
			} else if (selection.operation === "bootstrap.resume") {
				const resumed = await app.bootstrap.resume(selection.mappingKey);
				await editEphemeralResponse(app, interaction, { content: `Resumed bootstrap \`${resumed.jobId}\`.` });
			} else if (selection.operation === "reconcile.preview") {
				const preview = await app.reconciliation.preview(selection.mappingKey);
				await editEphemeralResponse(app, interaction, { content: formatReconciliation(preview) });
			} else if (selection.operation === "reconcile.start") {
				const result = await app.reconciliation.start(selection.mappingKey, interaction.member?.user.id);
				await editEphemeralResponse(app, interaction, {
					content: `Reconciliation \`${result.runId}\` scheduled.\n\n${formatReconciliation(result.preview)}`
				});
			} else if (selection.operation === "pause") {
				await app.databaseClient.execute({
					sql: "UPDATE mappings SET state = 'PAUSED', updated_at = ? WHERE key = ?",
					args: [Date.now(), selection.mappingKey]
				});
				await editEphemeralResponse(app, interaction, { content: `Paused \`${selection.mappingKey}\`.` });
			} else if (selection.operation === "resume") {
				await app.databaseClient.execute({
					sql: `
						UPDATE mappings SET state = CASE
							WHEN bootstrap_completed_at IS NULL THEN 'PENDING_BOOTSTRAP' ELSE 'ACTIVE'
						END, updated_at = ? WHERE key = ?
					`,
					args: [Date.now(), selection.mappingKey]
				});
				await editEphemeralResponse(app, interaction, { content: `Resumed \`${selection.mappingKey}\`.` });
			}
		} catch (error) {
			app.logger.warn("Relay administration command failed.", {
				error: error instanceof Error ? error : String(error),
				operation: selection.operation
			});
			await editEphemeralResponse(app, interaction, {
				content: error instanceof Error ? error.message : "The operation failed."
			});
		}
	}
});

function selectedOperation(options: readonly APIApplicationCommandInteractionDataOption[]) {
	const top = options[0];
	if (!top) {
		return { operation: "status" as const, mappingKey: undefined };
	}
	if (top.name === "bootstrap" && "options" in top) {
		const subcommand = top.options?.[0];
		const mappingKey = subcommand && "options" in subcommand ? mappingValue(subcommand.options ?? []) : undefined;
		return {
			operation: `bootstrap.${subcommand?.name ?? "preview"}` as
				| "bootstrap.pause"
				| "bootstrap.preview"
				| "bootstrap.resume"
				| "bootstrap.start",
			mappingKey: typeof mappingKey === "string" ? mappingKey : undefined
		};
	}
	if (top.name === "reconcile" && "options" in top) {
		const subcommand = top.options?.[0];
		const mappingKey = subcommand && "options" in subcommand ? mappingValue(subcommand.options ?? []) : undefined;
		return {
			operation: `reconcile.${subcommand?.name ?? "preview"}` as "reconcile.preview" | "reconcile.start",
			mappingKey
		};
	}
	if (top.name === "close" && "options" in top) {
		return {
			duplicateTarget: optionValue(top.options ?? [], "duplicate"),
			mappingKey: undefined,
			operation: "close" as const,
			reason: optionValue(top.options ?? [], "reason") ?? "completed"
		};
	}
	if (top.name === "failures" && "options" in top) {
		const subcommand = top.options?.[0];
		const values = subcommand && "options" in subcommand ? (subcommand.options ?? []) : [];
		return {
			failureId: optionValue(values, "id") ?? "",
			mappingKey: mappingValue(values),
			operation: `failures.${subcommand?.name ?? "list"}` as "failures.discard" | "failures.list" | "failures.retry"
		};
	}
	const mappingKey = "options" in top ? mappingValue(top.options ?? []) : undefined;
	return {
		operation:
			top.name === "doctor"
				? ("doctor" as const)
				: top.name === "pause"
					? ("pause" as const)
					: top.name === "resume"
						? ("resume" as const)
						: ("status" as const),
		mappingKey: typeof mappingKey === "string" ? mappingKey : undefined
	};
}

function mappingValue(options: readonly APIApplicationCommandInteractionDataOption[]) {
	return optionValue(options, "mapping");
}

function optionValue(options: readonly APIApplicationCommandInteractionDataOption[], name: string) {
	for (const option of options) {
		if (option.name === name && "value" in option && typeof option.value === "string") {
			return option.value;
		}
	}
	return undefined;
}

async function closeFromDiscord(
	app: BotApp,
	interaction: APIChatInputApplicationCommandInteraction,
	reason: string,
	duplicateTarget?: string
) {
	if (!interaction.channel_id || !interaction.member) {
		await respondEphemeral(app, interaction, { content: "Use this command inside a linked Discord forum thread." });
		return;
	}
	const relationship = await app.databaseClient.execute({
		sql: `
			SELECT link.id, link.mapping_key, link.github_issue_number
			FROM issue_thread_links link WHERE link.discord_thread_id = ?
		`,
		args: [interaction.channel_id]
	});
	const row = relationship.rows[0];
	if (!row) {
		await respondEphemeral(app, interaction, { content: "This Discord thread is not linked to a GitHub issue." });
		return;
	}
	const mappingKey = String(row.mapping_key);
	const mapping = app.config.mappings[mappingKey];
	if (!mapping || !isMappingModerator(app, mappingKey, interaction.member)) {
		await respondEphemeral(app, interaction, { content: "You are not authorized to close this mapped issue." });
		return;
	}
	if (reason === "duplicate" && !duplicateTarget) {
		throw new Error("A duplicate target is required when the close reason is duplicate.");
	}
	const duplicateUrl = duplicateTarget ? await resolveDuplicateTarget(app, mappingKey, duplicateTarget) : undefined;
	const actor = {
		avatarUrl: interaction.member.user.avatar
			? `https://cdn.discordapp.com/avatars/${interaction.member.user.id}/${interaction.member.user.avatar}.png`
			: undefined,
		displayName: interaction.member.user.username,
		id: interaction.member.user.id,
		username: interaction.member.user.username
	};
	const payloadActor = { ...actor, avatarUrl: actor.avatarUrl ?? null };
	const linkId = Number(row.id);
	const pendingClose = encodeURIComponent(
		JSON.stringify({ actor: payloadActor, duplicateUrl, reason: reason === "not-planned" ? "not_planned" : reason })
	);
	await app.databaseClient.execute({
		sql: "UPDATE issue_thread_links SET status = ?, updated_at = ? WHERE id = ?",
		args: [`PENDING_CLOSE:${pendingClose}`, Date.now(), linkId]
	});
	await app.jobs.enqueueOutbox({
		correlationId: crypto.randomUUID(),
		idempotencyKey: `github:lifecycle:command:${linkId}:close:${interaction.id}`,
		mappingKey,
		operationKind: "github.issue.lifecycle",
		partitionKey: `link:${linkId}`,
		payload: {
			action: "close",
			actor: payloadActor,
			duplicateUrl: duplicateUrl ?? null,
			linkId,
			reason: reason === "not-planned" ? "not_planned" : reason
		},
		platform: "github"
	});
	await respondEphemeral(app, interaction, {
		content: `Queued GitHub closure as **${reason}**${duplicateUrl ? ` of ${duplicateUrl}` : ""}.`
	});
}

function isMappingModerator(
	app: BotApp,
	mappingKey: string,
	member: { permissions: string; roles: string[]; user: { id: string } }
) {
	const mapping = app.config.mappings[mappingKey];
	return (
		isAdministrator(app, member) ||
		Boolean(mapping?.moderatorRoleIds.some((role) => member.roles.includes(role))) ||
		(BigInt(member.permissions) & PermissionFlagsBits.ManageThreads) === PermissionFlagsBits.ManageThreads
	);
}

async function resolveDuplicateTarget(app: BotApp, mappingKey: string, target: string) {
	const mapping = app.config.mappings[mappingKey];
	if (!mapping) {
		throw new Error("Mapping is unavailable.");
	}
	const threadMatch = target.match(/^<#(\d{17,20})>$/);
	if (threadMatch?.[1]) {
		const result = await app.databaseClient.execute({
			sql: "SELECT github_issue_number FROM issue_thread_links WHERE mapping_key = ? AND discord_thread_id = ?",
			args: [mappingKey, threadMatch[1]]
		});
		const number = result.rows[0]?.github_issue_number;
		if (typeof number === "number") {
			return `https://github.com/${mapping.repository.owner}/${mapping.repository.name}/issues/${number}`;
		}
		throw new Error("That Discord thread is not linked in this mapping.");
	}
	const numberMatch = target.match(/^#?(\d+)$/);
	if (numberMatch?.[1]) {
		return `https://github.com/${mapping.repository.owner}/${mapping.repository.name}/issues/${numberMatch[1]}`;
	}
	const url = new URL(target);
	const expectedPrefix = `/${mapping.repository.owner}/${mapping.repository.name}/issues/`.toLocaleLowerCase("en-US");
	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		!url.pathname.toLocaleLowerCase("en-US").startsWith(expectedPrefix) ||
		!/\/issues\/\d+\/?$/.test(url.pathname)
	) {
		throw new Error("Duplicate target must be an issue in the mapped repository or a mapped Discord thread.");
	}
	return url.toString();
}

async function statusText(app: BotApp) {
	const configuredMappings = Object.entries(app.config.mappings);
	const databaseMappings = await app.databaseClient.execute("SELECT key, state, last_error_code FROM mappings ORDER BY key");
	const stateByKey = new Map(
		databaseMappings.rows.map((row) => [
			String(row.key),
			{
				errorCode: typeof row.last_error_code === "string" ? row.last_error_code : undefined,
				state: String(row.state)
			}
		])
	);
	const summary =
		configuredMappings.length === 0
			? "No forum mappings are configured."
			: configuredMappings
					.map(([key, mapping]) => {
						const persisted = stateByKey.get(key);
						const state = persisted?.errorCode
							? `${persisted.state} (${persisted.errorCode})`
							: (persisted?.state ?? "INITIALIZING");
						return `• **${key}** · ${state}: <#${mapping.forumChannelId}> ↔ \`${mapping.repository.owner}/${mapping.repository.name}\``;
					})
					.join("\n");
	return `Forum Relay has ${configuredMappings.length} configured mapping(s).\n\n${summary}`;
}

async function doctorText(app: BotApp, mappingKey?: string) {
	const condition = mappingKey ? "WHERE mapping_key = ?" : "";
	const arguments_ = mappingKey ? [mappingKey] : [];
	const [inbox, outbox, mappings, labelBindings] = await Promise.all([
		app.databaseClient.execute({
			sql: `SELECT state, COUNT(*) AS count FROM inbox_events ${condition} GROUP BY state`,
			args: arguments_
		}),
		app.databaseClient.execute({
			sql: `SELECT state, COUNT(*) AS count FROM outbox_operations ${condition} GROUP BY state`,
			args: arguments_
		}),
		app.databaseClient.execute({
			sql: mappingKey
				? "SELECT key, state, last_error_code FROM mappings WHERE key = ?"
				: "SELECT key, state, last_error_code FROM mappings ORDER BY key",
			args: arguments_
		}),
		app.databaseClient.execute({
			sql: `SELECT state, COUNT(*) AS count FROM label_bindings ${condition} GROUP BY state`,
			args: arguments_
		})
	]);
	const mappingLines = mappings.rows.map(
		(row) => `• ${String(row.key)}: ${String(row.state)}${row.last_error_code ? ` · ${String(row.last_error_code)}` : ""}`
	);
	return [
		"**Mappings**",
		mappingLines.join("\n") || "No matching mapping.",
		"",
		`**Inbox** ${formatCounts(inbox.rows)}`,
		`**Outbox** ${formatCounts(outbox.rows)}`,
		`**Label tags** ${formatCounts(labelBindings.rows)}`
	].join("\n");
}

async function failuresText(app: BotApp, mappingKey?: string) {
	const filter = mappingKey ? "AND mapping_key = ?" : "";
	const args = mappingKey ? [mappingKey] : [];
	const [inbox, outbox] = await Promise.all([
		app.databaseClient.execute({
			sql: `
				SELECT id, mapping_key, event_kind AS kind, last_error_code
				FROM inbox_events WHERE state = 'dead' ${filter}
				ORDER BY updated_at DESC LIMIT 10
			`,
			args
		}),
		app.databaseClient.execute({
			sql: `
				SELECT id, mapping_key, operation_kind AS kind, last_error_code
				FROM outbox_operations WHERE state = 'dead' ${filter}
				ORDER BY updated_at DESC LIMIT 10
			`,
			args
		})
	]);
	const lines = [
		...inbox.rows.map((row) => ({
			errorCode: String(row.last_error_code),
			id: String(row.id),
			kind: String(row.kind),
			mappingKey: String(row.mapping_key),
			queue: "inbox"
		})),
		...outbox.rows.map((row) => ({
			errorCode: String(row.last_error_code),
			id: String(row.id),
			kind: String(row.kind),
			mappingKey: String(row.mapping_key),
			queue: "outbox"
		}))
	]
		.slice(0, 20)
		.map((row) => `• ${row.queue} \`${row.id}\` · ${row.mappingKey} · ${row.kind} · ${row.errorCode}`);
	return lines.length > 0 ? `**Dead letters**\n${lines.join("\n")}` : "No matching dead-letter work.";
}

async function mutateFailure(app: BotApp, id: string, action: "discard" | "retry") {
	if (!id) {
		throw new Error("A failure ID is required.");
	}
	const state = action === "retry" ? "pending" : "discarded";
	const nextAttemptAt = action === "retry" ? Date.now() : null;
	const statements = ["inbox_events", "outbox_operations"].map((table) => ({
		sql: `
			UPDATE ${table} SET state = ?, next_attempt_at = ?, claim_owner = NULL,
				claim_expires_at = NULL, updated_at = ? WHERE id = ? AND state = 'dead'
		`,
		args: [state, nextAttemptAt, Date.now(), id]
	}));
	const results = await app.databaseClient.batch(statements, "write");
	if (results.every((result) => result.rowsAffected === 0)) {
		throw new Error("No dead-letter event or operation has that ID.");
	}
}

function formatCounts(rows: readonly Row[]) {
	return rows.map((row) => `${String(row.state)}=${String(row.count)}`).join(", ") || "empty";
}

function formatPreview(preview: {
	blockers: string[];
	digest: string;
	mappingKey: string;
	sourceCount: number;
	sourcePlatform: string;
	targetCount: number;
	warnings: string[];
}) {
	return [
		`**Bootstrap preview · ${preview.mappingKey}**`,
		`Source: ${preview.sourcePlatform} (${preview.sourceCount} item(s))`,
		`Target content: ${preview.targetCount}`,
		`Digest: \`${preview.digest.slice(0, 16)}\``,
		preview.blockers.length ? `\n**Blockers**\n${preview.blockers.map((value) => `• ${value}`).join("\n")}` : "",
		preview.warnings.length ? `\n**Warnings**\n${preview.warnings.map((value) => `• ${value}`).join("\n")}` : ""
	]
		.filter(Boolean)
		.join("\n");
}

function formatReconciliation(preview: {
	digest: string;
	mappingKey: string;
	missingDiscordThreads: number;
	missingGitHubIssues: number;
	unlinkedDiscordThreads: number;
	unlinkedGitHubIssues: number;
}) {
	return [
		`**Reconciliation preview · ${preview.mappingKey}**`,
		`Unlinked GitHub issues: ${preview.unlinkedGitHubIssues}`,
		`Unlinked Discord threads: ${preview.unlinkedDiscordThreads}`,
		`Missing GitHub sources: ${preview.missingGitHubIssues}`,
		`Missing Discord threads: ${preview.missingDiscordThreads}`,
		`Digest: \`${preview.digest.slice(0, 16)}\``,
		"Deleted Discord threads are marked missing and are never recreated automatically."
	].join("\n");
}

function isAdministrator(app: BotApp, member: { permissions: string; roles: string[]; user: { id: string } } | undefined) {
	if (!member) {
		return false;
	}
	if (member.user.id === app.config.ownerId || member.roles.some((role) => app.config.administratorRoleIds.includes(role))) {
		return true;
	}
	return (BigInt(member.permissions) & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
}
