import { describe, expect, it } from "vitest";
import { decideDiscordEdit } from "@/domain/conflicts.js";
import { classifyThreadTransition, type ThreadState } from "@/domain/state-transitions.js";

const open: ThreadState = {
	appliedTags: ["one"],
	archived: false,
	locked: false,
	name: "Title"
};

describe("classifyThreadTransition", () => {
	it("suppresses self operations and classifies unaudited inactivity conservatively", () => {
		expect(classifyThreadTransition(open, { ...open, archived: true }, "self")).toEqual({ kind: "self" });
		expect(classifyThreadTransition(open, { ...open, archived: true }, "none")).toEqual({
			kind: "inactivity-archive"
		});
		expect(classifyThreadTransition(open, { ...open, locked: true }, "none")).toEqual({ kind: "ambiguous" });
		expect(classifyThreadTransition(open, open, "none")).toEqual({ kind: "none" });
	});

	it("prioritizes audited lock and archive changes", () => {
		expect(classifyThreadTransition(open, { ...open, locked: true }, "human-audit")).toEqual({ kind: "lock" });
		expect(classifyThreadTransition({ ...open, locked: true }, open, "human-audit")).toEqual({ kind: "unlock" });
		expect(classifyThreadTransition(open, { ...open, archived: true }, "human-audit")).toEqual({ kind: "close" });
		expect(classifyThreadTransition({ ...open, archived: true }, open, "human-audit")).toEqual({ kind: "reopen" });
	});

	it("classifies names, tag changes, tag removal, and no-op updates", () => {
		expect(classifyThreadTransition(open, { ...open, name: "Renamed" }, "human-audit")).toEqual({
			kind: "rename",
			title: "Renamed"
		});
		expect(classifyThreadTransition(open, { ...open, appliedTags: ["two"] }, "human-audit")).toEqual({
			kind: "labels",
			tagIds: ["two"]
		});
		expect(classifyThreadTransition(open, { ...open, appliedTags: [] }, "human-audit")).toEqual({
			kind: "labels",
			tagIds: []
		});
		expect(classifyThreadTransition(open, { ...open }, "human-audit")).toEqual({ kind: "none" });
		const withoutTags = { ...open, appliedTags: undefined };
		expect(classifyThreadTransition(withoutTags, withoutTags, "human-audit")).toEqual({ kind: "none" });
		expect(classifyThreadTransition(withoutTags, { ...withoutTags, appliedTags: ["new"] }, "human-audit")).toEqual({
			kind: "labels",
			tagIds: ["new"]
		});
		expect(classifyThreadTransition(open, withoutTags, "human-audit")).toEqual({
			kind: "labels",
			tagIds: []
		});
		expect(classifyThreadTransition(open, { ...open, appliedTags: ["one", "two"] }, "none")).toEqual({
			kind: "ambiguous"
		});
	});
});

describe("decideDiscordEdit", () => {
	it("applies an initial or unchanged destination and preserves independent GitHub edits", () => {
		expect(decideDiscordEdit(undefined, "github")).toBe("apply-discord");
		expect(decideDiscordEdit("same", "same")).toBe("apply-discord");
		expect(decideDiscordEdit("old", "new")).toBe("preserve-github");
	});
});
