import type { AnyVersionedConfig, BootstrapConfig, ConfigV0_0_1, ForumMappingConfig } from "@/config/index.js";

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const MAPPING_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface NormalizedMaintenanceConfig {
	failedWebhookDeliveryCheckMinutes: number;
	fullReconciliationIntervalHours: number;
	localBackupCount: number;
	processedPayloadRetentionDays: number;
}

export interface NormalizedConfig extends Omit<ConfigV0_0_1, "maintenance" | "mappings"> {
	maintenance: NormalizedMaintenanceConfig;
	mappings: Record<string, ForumMappingConfig>;
	version: "0.0.1";
}

export function normalizeConfig(config: AnyVersionedConfig): NormalizedConfig {
	switch (config.version) {
		case "0.0.1":
			return validateV0_0_1(config);
	}
}

function validateV0_0_1(config: ConfigV0_0_1 & { version: "0.0.1" }): NormalizedConfig {
	validateSnowflake(config.clientId, "clientId");
	validateSnowflake(config.guildId, "guildId");
	validateSnowflake(config.ownerId, "ownerId");
	validateSnowflakes(config.administratorRoleIds, "administratorRoleIds");

	if (config.logChannelId) {
		validateSnowflake(config.logChannelId, "logChannelId");
	}

	validatePublicBaseUrl(config.publicBaseUrl);
	validateMappings(config.mappings);

	const maintenance: NormalizedMaintenanceConfig = {
		failedWebhookDeliveryCheckMinutes: config.maintenance?.failedWebhookDeliveryCheckMinutes ?? 5,
		fullReconciliationIntervalHours: config.maintenance?.fullReconciliationIntervalHours ?? 24,
		localBackupCount: config.maintenance?.localBackupCount ?? 7,
		processedPayloadRetentionDays: config.maintenance?.processedPayloadRetentionDays ?? 30
	};

	validatePositiveInteger(maintenance.failedWebhookDeliveryCheckMinutes, "maintenance.failedWebhookDeliveryCheckMinutes", 1_440);
	validatePositiveInteger(maintenance.fullReconciliationIntervalHours, "maintenance.fullReconciliationIntervalHours", 720);
	validatePositiveInteger(maintenance.localBackupCount, "maintenance.localBackupCount", 365);
	validatePositiveInteger(maintenance.processedPayloadRetentionDays, "maintenance.processedPayloadRetentionDays", 3_650);

	return {
		...config,
		administratorRoleIds: [...config.administratorRoleIds],
		maintenance,
		mappings: cloneMappings(config.mappings)
	};
}

function validateMappings(mappings: Record<string, ForumMappingConfig>) {
	const forumIds = new Set<string>();
	const repositories = new Set<string>();

	for (const [mappingKey, mapping] of Object.entries(mappings)) {
		if (!MAPPING_KEY_PATTERN.test(mappingKey)) {
			throw new Error(`Mapping key "${mappingKey}" must use lowercase letters, numbers, hyphens, or underscores.`);
		}

		validateSnowflake(mapping.forumChannelId, `mappings.${mappingKey}.forumChannelId`);
		validateSnowflakes(mapping.moderatorRoleIds, `mappings.${mappingKey}.moderatorRoleIds`);
		validateRepository(mappingKey, mapping);
		validateBootstrap(mappingKey, mapping.bootstrap);

		if (forumIds.has(mapping.forumChannelId)) {
			throw new Error(`Discord forum ${mapping.forumChannelId} is configured in more than one mapping.`);
		}
		forumIds.add(mapping.forumChannelId);

		const repositoryKey = `${mapping.repository.owner}/${mapping.repository.name}`.toLocaleLowerCase("en-US");
		if (repositories.has(repositoryKey)) {
			throw new Error(`GitHub repository ${repositoryKey} is configured in more than one mapping.`);
		}
		repositories.add(repositoryKey);
	}
}

function validateRepository(mappingKey: string, mapping: ForumMappingConfig) {
	if (!mapping.repository.owner.trim() || !mapping.repository.name.trim()) {
		throw new Error(`Mapping "${mappingKey}" must configure a GitHub owner and repository name.`);
	}

	if (
		mapping.repository.owner.includes("/") ||
		mapping.repository.name.includes("/") ||
		mapping.repository.name.endsWith(".git")
	) {
		throw new Error(`Mapping "${mappingKey}" contains an invalid GitHub repository locator.`);
	}
}

function validateBootstrap(mappingKey: string, bootstrap: BootstrapConfig) {
	if (bootstrap.createdAfter && Number.isNaN(Date.parse(bootstrap.createdAfter))) {
		throw new Error(`Mapping "${mappingKey}" bootstrap.createdAfter must be ISO 8601.`);
	}

	if (bootstrap.source !== "discord" || !bootstrap.stateOverrides) {
		return;
	}

	for (const [threadId] of Object.entries(bootstrap.stateOverrides)) {
		validateSnowflake(threadId, `mappings.${mappingKey}.bootstrap.stateOverrides thread ID`);
	}
}

function validateSnowflakes(values: string[], path: string) {
	const seen = new Set<string>();

	for (const value of values) {
		validateSnowflake(value, path);
		if (seen.has(value)) {
			throw new Error(`${path} contains duplicate Discord ID ${value}.`);
		}
		seen.add(value);
	}
}

function validateSnowflake(value: string, path: string) {
	if (!SNOWFLAKE_PATTERN.test(value)) {
		throw new Error(`${path} must be a Discord snowflake.`);
	}
}

function validatePublicBaseUrl(value: string) {
	const url = new URL(value);

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("publicBaseUrl must use HTTP or HTTPS.");
	}

	if (url.pathname !== "/" || url.search || url.hash) {
		throw new Error("publicBaseUrl must be an origin without a path, query, or fragment.");
	}
}

function validatePositiveInteger(value: number, path: string, maximum: number) {
	if (!Number.isInteger(value) || value < 1 || value > maximum) {
		throw new Error(`${path} must be an integer between 1 and ${maximum}.`);
	}
}

function cloneMappings(mappings: Record<string, ForumMappingConfig>) {
	return Object.fromEntries(
		Object.entries(mappings).map(([key, mapping]) => [
			key,
			{
				...mapping,
				bootstrap: {
					...mapping.bootstrap,
					...(mapping.bootstrap.source === "discord" && mapping.bootstrap.stateOverrides
						? {
								stateOverrides: { ...mapping.bootstrap.stateOverrides }
							}
						: {})
				},
				moderatorRoleIds: [...mapping.moderatorRoleIds],
				repository: { ...mapping.repository }
			}
		])
	);
}
