export type FailureCategory = "authentication" | "conflict" | "invalid" | "not-found" | "rate-limit" | "temporary";

export interface RetryDecision {
	delayMs?: number;
	state: "dead" | "pending";
}

export interface RetryPolicy {
	baseDelayMs: number;
	maxAttempts: number;
	maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	baseDelayMs: 1_000,
	maxAttempts: 10,
	maxDelayMs: 15 * 60_000
};

export class RelayFailure extends Error {
	public constructor(
		message: string,
		public readonly category: FailureCategory,
		public readonly code: string,
		public readonly retryAfterMs?: number
	) {
		super(message);
		this.name = "RelayFailure";
	}
}

export function retryDecision(
	failure: RelayFailure,
	attemptCount: number,
	random: () => number = Math.random,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY
): RetryDecision {
	if (
		attemptCount >= policy.maxAttempts ||
		failure.category === "authentication" ||
		failure.category === "invalid" ||
		failure.category === "not-found"
	) {
		return { state: "dead" };
	}

	if (failure.retryAfterMs !== undefined) {
		return {
			state: "pending",
			delayMs: Math.min(Math.max(0, failure.retryAfterMs), policy.maxDelayMs)
		};
	}

	const exponentialCeiling = Math.min(policy.baseDelayMs * 2 ** Math.max(0, attemptCount - 1), policy.maxDelayMs);
	return {
		state: "pending",
		delayMs: Math.floor(exponentialCeiling * Math.min(1, Math.max(0, random())))
	};
}

export function normalizeFailure(error: Error) {
	if (error instanceof RelayFailure) {
		return error;
	}

	return new RelayFailure(error.message, "temporary", "UNEXPECTED");
}
