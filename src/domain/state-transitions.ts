export interface ThreadState {
	appliedTags?: readonly string[];
	archived: boolean;
	locked: boolean;
	name: string;
}

export type TransitionEvidence = "human-audit" | "none" | "self";

export type ThreadTransition =
	| { kind: "ambiguous" }
	| { kind: "close" }
	| { kind: "inactivity-archive" }
	| { kind: "labels"; tagIds: readonly string[] }
	| { kind: "lock" }
	| { kind: "none" }
	| { kind: "rename"; title: string }
	| { kind: "reopen" }
	| { kind: "self" }
	| { kind: "unlock" };

export function classifyThreadTransition(
	previous: ThreadState,
	observed: ThreadState,
	evidence: TransitionEvidence
): ThreadTransition {
	if (evidence === "self") {
		return { kind: "self" };
	}
	if (evidence === "none") {
		if (!previous.archived && observed.archived && !observed.locked) {
			return { kind: "inactivity-archive" };
		}
		return statesEqual(previous, observed) ? { kind: "none" } : { kind: "ambiguous" };
	}

	if (previous.locked !== observed.locked) {
		return { kind: observed.locked ? "lock" : "unlock" };
	}
	if (previous.archived !== observed.archived) {
		return { kind: observed.archived ? "close" : "reopen" };
	}
	if (previous.name !== observed.name) {
		return { kind: "rename", title: observed.name };
	}
	if (!arraysEqual(previous.appliedTags ?? [], observed.appliedTags ?? [])) {
		return { kind: "labels", tagIds: observed.appliedTags ?? [] };
	}
	return { kind: "none" };
}

function statesEqual(left: ThreadState, right: ThreadState) {
	return (
		left.archived === right.archived &&
		left.locked === right.locked &&
		left.name === right.name &&
		arraysEqual(left.appliedTags ?? [], right.appliedTags ?? [])
	);
}

function arraysEqual(left: readonly string[], right: readonly string[]) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
