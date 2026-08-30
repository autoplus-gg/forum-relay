export type ActivityTypeName = "PLAYING" | "STREAMING" | "LISTENING" | "WATCHING" | "CUSTOM" | "COMPETING";
export type PresenceStatusName = "online" | "idle" | "dnd" | "invisible";
export type BootstrapSource = "github" | "discord";
export type BootstrapIssueFilter = "all" | "open-only";
export type BootstrapThreadFilter = "all" | "active-only";

export interface BootstrapStateOverride {
	state: "open" | "closed";
	locked: boolean;
}

export interface GitHubBootstrapConfig {
	source: "github";
	issueFilter: BootstrapIssueFilter;
	createdAfter?: string;
}

export interface DiscordBootstrapConfig {
	source: "discord";
	threadFilter: BootstrapThreadFilter;
	createdAfter?: string;
	stateOverrides?: Record<string, BootstrapStateOverride>;
}

export type BootstrapConfig = GitHubBootstrapConfig | DiscordBootstrapConfig;

export interface RepositoryConfig {
	owner: string;
	name: string;
}

export interface ForumMappingConfig {
	forumChannelId: string;
	repository: RepositoryConfig;
	moderatorRoleIds: string[];
	bootstrap: BootstrapConfig;
}

export interface ConfigV0_0_1 {
	clientId: string;
	guildId: string;
	ownerId: string;
	administratorRoleIds: string[];
	logChannelId?: string;
	publicBaseUrl: string;
	maintenance?: {
		failedWebhookDeliveryCheckMinutes?: number;
		fullReconciliationIntervalHours?: number;
		localBackupCount?: number;
		processedPayloadRetentionDays?: number;
	};
	status?: {
		enabled: boolean;
		text?: string;
		type?: ActivityTypeName;
		url?: string;
		status: PresenceStatusName;
	};
	mappings: Record<string, ForumMappingConfig>;
}

export interface ConfigVersions {
	"0.0.1": ConfigV0_0_1;
}

export type ConfigVersion = keyof ConfigVersions;
export type ConfigOf<TVersion extends ConfigVersion> = ConfigVersions[TVersion];

export type VersionedConfig<TVersion extends ConfigVersion = ConfigVersion> = {
	version: TVersion;
} & ConfigOf<TVersion>;

export type AnyVersionedConfig = {
	[TVersion in ConfigVersion]: VersionedConfig<TVersion>;
}[ConfigVersion];

export function defineConfig<const TVersion extends ConfigVersion>(
	version: TVersion,
	config: ConfigOf<TVersion>
): VersionedConfig<TVersion> {
	return {
		version,
		...config
	};
}
