import { afterEach, describe, expect, it } from "vitest";
import { normalizeConfig } from "@/config/normalize.js";
import type { DatabaseContext } from "@/db/client.js";
import { JobRepository } from "@/db/job-repository.js";
import { MappingRepository } from "@/db/mapping-repository.js";
import { RelayFailure } from "@/jobs/retry-policy.js";
import config from "../../config/config.example.js";
import { createTestDatabase } from "../helpers/database.js";

let database: DatabaseContext | undefined;

afterEach(() => database?.close());

async function setup() {
	database = await createTestDatabase();
	await new MappingRepository(database.client).applyConfig(normalizeConfig(config));
	await database.client.execute("UPDATE mappings SET state = 'ACTIVE'");
	return new JobRepository(database.client);
}

describe("JobRepository", () => {
	it("deduplicates inbox events and reclaims expired work", async () => {
		const repository = await setup();
		const event = {
			eventKind: "issue.opened",
			idempotencyKey: "delivery-1",
			mappingKey: "feedback",
			partitionKey: "issue:1",
			payload: { issue: 1 },
			platform: "github" as const
		};

		expect(await repository.enqueueInbox(event)).toBe(true);
		expect(await repository.enqueueInbox(event)).toBe(false);
		const now = Date.now();
		const first = await repository.claimInbox("worker-a", 100, now);
		expect(first?.attemptCount).toBe(1);
		expect(await repository.claimInbox("worker-b", 100, now + 50)).toBeUndefined();
		const reclaimed = await repository.claimInbox("worker-b", 100, now + 101);
		expect(reclaimed?.id).toBe(first?.id);
		expect(reclaimed?.attemptCount).toBe(2);
	});

	it("preserves partition order and releases retryable work", async () => {
		const repository = await setup();
		for (const id of ["first", "second"]) {
			await repository.enqueueInbox({
				eventKind: "message",
				idempotencyKey: id,
				mappingKey: "feedback",
				partitionKey: "thread:1",
				payload: { id },
				platform: "discord"
			});
		}
		if (!database) {
			throw new Error("Expected test database.");
		}
		await database.client.execute({
			sql: `
				UPDATE inbox_events
				SET id = CASE idempotency_key WHEN 'first' THEN 'z-first' ELSE 'a-second' END,
					created_at = 100
				WHERE idempotency_key IN ('first', 'second')
			`
		});

		const first = await repository.claimInbox("worker", 1_000, Date.now());
		expect(first?.payload).toEqual({ id: "first" });
		expect(await repository.claimInbox("worker", 1_000, Date.now())).toBeUndefined();
		if (!first) {
			throw new Error("Expected first job.");
		}
		await repository.failInbox(
			first.id,
			"worker",
			new RelayFailure("later", "temporary", "LATER"),
			{ state: "pending", delayMs: 10_000 },
			Date.now()
		);
		expect(await repository.claimInbox("worker", 1_000, Date.now())).toBeUndefined();
	});

	it("waits for outbox dependencies", async () => {
		const repository = await setup();
		const parent = await repository.enqueueOutbox({
			correlationId: "correlation",
			idempotencyKey: "create-thread",
			mappingKey: "feedback",
			operationKind: "thread.create",
			partitionKey: "issue:1",
			payload: {},
			platform: "discord"
		});
		if (!parent) {
			throw new Error("Expected parent operation.");
		}
		await repository.enqueueOutbox({
			correlationId: "correlation",
			dependsOn: [parent],
			idempotencyKey: "post-comment",
			mappingKey: "feedback",
			operationKind: "message.create",
			partitionKey: "issue:2",
			payload: {},
			platform: "discord"
		});

		const claimedParent = await repository.claimOutbox("worker", 1_000);
		expect(claimedParent?.id).toBe(parent);
		expect(await repository.claimOutbox("worker", 1_000)).toBeUndefined();
		if (!claimedParent) {
			throw new Error("Expected claimed parent.");
		}
		await repository.completeOutbox(claimedParent.id, "worker", { threadId: "123" });
		expect((await repository.claimOutbox("worker", 1_000))?.operationKind).toBe("message.create");
	});

	it("releases a later lifecycle transition after an earlier operation is dead", async () => {
		const repository = await setup();
		for (const action of ["closed", "reopened"]) {
			await repository.enqueueOutbox({
				correlationId: action,
				idempotencyKey: `lifecycle-${action}`,
				mappingKey: "feedback",
				operationKind: "discord.issue.lifecycle",
				partitionKey: "link:sequence",
				payload: { action },
				platform: "discord"
			});
		}

		const closed = await repository.claimOutbox("worker", 1_000);
		expect(closed?.payload).toEqual({ action: "closed" });
		if (!closed) {
			throw new Error("Expected close operation.");
		}
		await repository.failOutbox(closed.id, "worker", new RelayFailure("Invalid enrichment", "invalid", "INVALID"), {
			state: "dead"
		});

		expect((await repository.claimOutbox("worker", 1_000))?.payload).toEqual({ action: "reopened" });
	});

	it("lets a thread sync repair a lifecycle operation that was queued first", async () => {
		const repository = await setup();
		const lifecycle = await repository.enqueueOutbox({
			correlationId: "bootstrap",
			idempotencyKey: "close-thread",
			mappingKey: "feedback",
			operationKind: "discord.issue.lifecycle",
			partitionKey: "link:1",
			payload: {},
			platform: "discord"
		});
		const claimedLifecycle = await repository.claimOutbox("worker", 1_000);
		expect(claimedLifecycle?.id).toBe(lifecycle);
		if (!claimedLifecycle) {
			throw new Error("Expected lifecycle operation.");
		}
		await repository.failOutbox(
			claimedLifecycle.id,
			"worker",
			new RelayFailure("Thread pending", "temporary", "THREAD_PENDING"),
			{ state: "pending", delayMs: 10_000 }
		);
		await repository.enqueueOutbox({
			correlationId: "recovered-webhook",
			idempotencyKey: "remove-label",
			mappingKey: "feedback",
			operationKind: "discord.issue.lifecycle",
			partitionKey: "link:1",
			payload: {},
			platform: "discord"
		});

		const threadSync = await repository.enqueueOutbox({
			correlationId: "bootstrap",
			idempotencyKey: "create-thread",
			mappingKey: "feedback",
			operationKind: "discord.item.sync",
			partitionKey: "link:1",
			payload: {},
			platform: "discord"
		});

		expect((await repository.claimOutbox("worker", 1_000))?.id).toBe(threadSync);
	});

	it("revives lifecycle work that died while waiting for its thread", async () => {
		const repository = await setup();
		const lifecycle = await repository.enqueueOutbox({
			correlationId: "bootstrap",
			idempotencyKey: "lock-thread",
			mappingKey: "feedback",
			operationKind: "discord.issue.lifecycle",
			partitionKey: "link:2",
			payload: {},
			platform: "discord"
		});
		const claimedLifecycle = await repository.claimOutbox("worker", 1_000);
		if (!claimedLifecycle) {
			throw new Error("Expected lifecycle operation.");
		}
		await repository.failOutbox(
			claimedLifecycle.id,
			"worker",
			new RelayFailure("Thread pending", "temporary", "THREAD_PENDING"),
			{ state: "dead" }
		);
		const threadSync = await repository.enqueueOutbox({
			correlationId: "bootstrap",
			idempotencyKey: "create-thread-2",
			mappingKey: "feedback",
			operationKind: "discord.item.sync",
			partitionKey: "link:2",
			payload: {},
			platform: "discord"
		});
		const claimedSync = await repository.claimOutbox("worker", 1_000);
		expect(claimedSync?.id).toBe(threadSync);
		expect(await repository.resumeThreadPendingLifecycles("link:2")).toBe(1);
		if (!claimedSync) {
			throw new Error("Expected thread sync operation.");
		}
		await repository.completeOutbox(claimedSync.id, "worker", {});
		expect((await repository.claimOutbox("worker", 1_000))?.id).toBe(lifecycle);
	});

	it("resumes dead thread-pending lifecycle work for a failed bootstrap", async () => {
		const repository = await setup();
		await repository.enqueueOutbox({
			correlationId: "bootstrap",
			idempotencyKey: "close-thread-3",
			mappingKey: "feedback",
			operationKind: "discord.issue.lifecycle",
			partitionKey: "link:3",
			payload: {},
			platform: "discord"
		});
		const lifecycle = await repository.claimOutbox("worker", 1_000);
		if (!lifecycle) {
			throw new Error("Expected lifecycle operation.");
		}
		await repository.failOutbox(lifecycle.id, "worker", new RelayFailure("Thread pending", "temporary", "THREAD_PENDING"), {
			state: "dead"
		});

		expect(await repository.resumeDeadThreadPendingLifecycles("feedback")).toBe(1);
		expect((await repository.claimOutbox("worker", 1_000))?.id).toBe(lifecycle.id);
	});
});
