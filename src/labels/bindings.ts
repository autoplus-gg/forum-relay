export interface RepositoryLabel {
	id: number;
	name: string;
}

export interface StoredLabelBinding {
	configuredDiscordName: string;
	configuredGithubName: string;
	discordCurrentName?: string;
	discordTagId?: string;
	githubLabelId?: number;
}

export interface PlannedLabelBinding {
	configuredDiscordName: string;
	configuredGithubName: string;
	discordCurrentName?: string;
	discordTagId?: string;
	githubLabelId: number;
	position: number;
	state: "PARTIAL" | "RESOLVED" | "STALE_GITHUB";
}

export interface DiscordForumTag {
	emoji_id: string | null;
	emoji_name: string | null;
	id: string;
	moderated: boolean;
	name: string;
}

export interface DiscordTagBindingInput {
	desiredName: string;
	position: number;
	storedTagId?: string;
}

export interface DiscordTagResolution {
	position: number;
	submittedIndex: number;
	tagId?: string;
}

export function planDiscordForumTags(
	currentTags: readonly DiscordForumTag[],
	bindings: readonly DiscordTagBindingInput[],
	staleTagIds: ReadonlySet<string>,
	maximumTags = 20
) {
	const tags = currentTags.filter((tag) => !staleTagIds.has(tag.id));
	const resolutions: DiscordTagResolution[] = [];
	const claimedTagIds = new Set<string>();
	let changed = tags.length !== currentTags.length;

	for (const binding of bindings) {
		// Once bound, the Discord snowflake is authoritative. Its name is a
		// Discord-local display value and must survive GitHub label renames.
		let tag = binding.storedTagId
			? tags.find((candidate) => candidate.id === binding.storedTagId && !claimedTagIds.has(candidate.id))
			: undefined;
		if (!tag) {
			tag = tags.find(
				(candidate) =>
					!claimedTagIds.has(candidate.id) &&
					candidate.name.toLocaleLowerCase("en-US") === binding.desiredName.toLocaleLowerCase("en-US")
			);
		}

		if (!tag) {
			if (tags.length >= maximumTags) {
				continue;
			}
			tag = {
				emoji_id: null,
				emoji_name: null,
				id: `new:${binding.position}`,
				moderated: false,
				name: binding.desiredName
			};
			tags.push(tag);
			changed = true;
		}

		claimedTagIds.add(tag.id);
		resolutions.push({
			position: binding.position,
			submittedIndex: tags.findIndex((candidate) => candidate.id === tag.id),
			tagId: tag.id.startsWith("new:") ? undefined : tag.id
		});
	}

	return { changed, resolutions, tags };
}

export function planLabelBindings(
	labels: readonly RepositoryLabel[],
	stored: readonly StoredLabelBinding[]
): PlannedLabelBinding[] {
	const orderedLabels = [...labels].sort(compareLabels);
	const includedIds = new Set(orderedLabels.map((label) => label.id));

	const storedByGithubId = new Map(
		stored.flatMap((binding) => (binding.githubLabelId === undefined ? [] : [[binding.githubLabelId, binding] as const]))
	);
	const planned = orderedLabels.map((label, position): PlannedLabelBinding => {
		const previous = storedByGithubId.get(label.id);
		return {
			configuredDiscordName: discordTagName(label),
			configuredGithubName: label.name,
			discordCurrentName: previous?.discordCurrentName,
			discordTagId: previous?.discordTagId,
			githubLabelId: label.id,
			position,
			state: previous?.discordTagId ? "RESOLVED" : "PARTIAL"
		};
	});

	for (const previous of stored) {
		if (previous.githubLabelId === undefined || includedIds.has(previous.githubLabelId)) {
			continue;
		}
		planned.push({
			configuredDiscordName: previous.configuredDiscordName,
			configuredGithubName: previous.configuredGithubName,
			discordCurrentName: previous.discordCurrentName,
			discordTagId: previous.discordTagId,
			githubLabelId: previous.githubLabelId,
			position: planned.length,
			state: "STALE_GITHUB"
		});
	}

	return planned;
}

export function discordTagName(label: RepositoryLabel) {
	const characters = Array.from(label.name);
	if (characters.length <= 20) {
		return label.name;
	}

	// The complete base-36 label ID makes shortened names deterministic and collision-free per repository.
	const suffix = `~${label.id.toString(36)}`;
	return `${characters.slice(0, 20 - suffix.length).join("")}${suffix}`;
}

function compareLabels(left: RepositoryLabel, right: RepositoryLabel) {
	return left.name.localeCompare(right.name, "en-US", { sensitivity: "base" }) || left.id - right.id;
}
