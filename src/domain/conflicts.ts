export type ConflictDecision = "apply-discord" | "preserve-github";

export function decideDiscordEdit(storedDestinationHash: string | undefined, currentGitHubHash: string): ConflictDecision {
	return storedDestinationHash === undefined || storedDestinationHash === currentGitHubHash ? "apply-discord" : "preserve-github";
}
