import { describe, expect, it } from "vitest";
import { createCustomId, parseCustomId } from "@/core/custom-id.js";

describe("custom IDs", () => {
	it("round-trips encoded state without changing the route", () => {
		const customId = createCustomId("relay", "restore", "owner/repo#12", "spaces and : separators");

		expect(parseCustomId(customId)).toEqual({
			featureKey: "relay",
			action: "restore",
			state: ["owner/repo#12", "spaces and : separators"]
		});
	});

	it("rejects IDs without both a feature and action", () => {
		expect(parseCustomId("relay")).toBeNull();
		expect(parseCustomId("")).toBeNull();
	});
});
