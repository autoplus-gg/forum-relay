import { describe, expect, it } from "vitest";
import { RelayFailure, retryDecision } from "@/jobs/retry-policy.js";

describe("retryDecision", () => {
	it("uses bounded full-jitter exponential backoff", () => {
		const failure = new RelayFailure("busy", "temporary", "BUSY");

		expect(retryDecision(failure, 3, () => 0.5, { baseDelayMs: 1_000, maxAttempts: 10, maxDelayMs: 60_000 })).toEqual({
			state: "pending",
			delayMs: 2_000
		});
	});

	it("honors retry-after and permanently rejects invalid work", () => {
		expect(retryDecision(new RelayFailure("limited", "rate-limit", "LIMITED", 12_345), 1)).toEqual({
			state: "pending",
			delayMs: 12_345
		});
		expect(retryDecision(new RelayFailure("bad", "invalid", "BAD"), 1)).toEqual({ state: "dead" });
	});
});
