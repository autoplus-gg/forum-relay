import { createHash } from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import type { NormalizedConfig } from "@/config/normalize.js";

export type MappingState = "DISABLED" | "PENDING_BOOTSTRAP";

export interface MappingIdentity {
	forumChannelId: string;
	githubOwner: string;
	githubRepository: string;
}

export class MappingIdentityChangedError extends Error {
	public constructor(
		public readonly mappingKey: string,
		public readonly stored: MappingIdentity,
		public readonly configured: MappingIdentity
	) {
		super(
			`Mapping "${mappingKey}" changed its forum or repository identity. Use the cleanup/migration workflow before reusing a mapping key.`
		);
		this.name = "MappingIdentityChangedError";
	}
}

export class MappingRepository {
	public constructor(private readonly client: Client) {}

	public async applyConfig(config: NormalizedConfig) {
		const transaction = await this.client.transaction("write");

		try {
			for (const [mappingKey, mapping] of Object.entries(config.mappings)) {
				const identity: MappingIdentity = {
					forumChannelId: mapping.forumChannelId,
					githubOwner: mapping.repository.owner,
					githubRepository: mapping.repository.name
				};
				await assertStableIdentity(transaction, mappingKey, identity);

				const now = Date.now();
				const fingerprint = fingerprintMapping(mapping);
				await transaction.execute({
					sql: `
						INSERT INTO mappings (
							key, guild_id, forum_channel_id, github_owner, github_repository,
							state, config_fingerprint, created_at, updated_at
						) VALUES (?, ?, ?, ?, ?, 'PENDING_BOOTSTRAP', ?, ?, ?)
						ON CONFLICT(key) DO UPDATE SET
							guild_id = excluded.guild_id,
							config_fingerprint = excluded.config_fingerprint,
							disabled_at = NULL,
							updated_at = excluded.updated_at
					`,
					args: [
						mappingKey,
						config.guildId,
						identity.forumChannelId,
						identity.githubOwner,
						identity.githubRepository,
						fingerprint,
						now,
						now
					]
				});

				// Label bindings are remote identities discovered from GitHub, not configuration rows.
				// Keeping them here would delete automatically discovered labels on every restart.
			}

			const configuredKeys = Object.keys(config.mappings);
			if (configuredKeys.length === 0) {
				await transaction.execute({
					sql: "UPDATE mappings SET state = 'DISABLED', disabled_at = ?, updated_at = ? WHERE disabled_at IS NULL",
					args: [Date.now(), Date.now()]
				});
			} else {
				const placeholders = configuredKeys.map(() => "?").join(", ");
				await transaction.execute({
					sql: `
						UPDATE mappings SET state = 'DISABLED', disabled_at = ?, updated_at = ?
						WHERE key NOT IN (${placeholders}) AND disabled_at IS NULL
					`,
					args: [Date.now(), Date.now(), ...configuredKeys]
				});
			}

			await transaction.commit();
		} catch (error) {
			await transaction.rollback();
			throw error;
		}
	}
}

async function assertStableIdentity(transaction: Transaction, mappingKey: string, configured: MappingIdentity) {
	const result = await transaction.execute({
		sql: `
			SELECT forum_channel_id, github_owner, github_repository
			FROM mappings WHERE key = ?
		`,
		args: [mappingKey]
	});
	const row = result.rows[0];

	if (!row) {
		return;
	}

	const stored: MappingIdentity = {
		forumChannelId: String(row.forum_channel_id),
		githubOwner: String(row.github_owner),
		githubRepository: String(row.github_repository)
	};

	if (
		stored.forumChannelId !== configured.forumChannelId ||
		stored.githubOwner.toLocaleLowerCase("en-US") !== configured.githubOwner.toLocaleLowerCase("en-US") ||
		stored.githubRepository.toLocaleLowerCase("en-US") !== configured.githubRepository.toLocaleLowerCase("en-US")
	) {
		throw new MappingIdentityChangedError(mappingKey, stored, configured);
	}
}

function fingerprintMapping(mapping: NormalizedConfig["mappings"][string]) {
	return createHash("sha256").update(JSON.stringify(mapping)).digest("hex");
}
