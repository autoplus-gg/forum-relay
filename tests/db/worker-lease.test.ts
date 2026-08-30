import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@/core/logger.js";
import type { DatabaseContext } from "@/db/client.js";
import { WorkerLease } from "@/jobs/worker-lease.js";
import { createTestDatabase } from "../helpers/database.js";

let database: DatabaseContext | undefined;
afterEach(() => database?.close());

describe("WorkerLease", () => {
	it("allows only one process until release", async () => {
		database = await createTestDatabase();
		const logger = createLogger("test", { level: "error", write: () => undefined });
		const first = new WorkerLease({
			client: database.client,
			hostLabel: "host",
			instanceId: "first",
			logger,
			onLeaseLost: vi.fn()
		});
		const second = new WorkerLease({
			client: database.client,
			hostLabel: "host",
			instanceId: "second",
			logger,
			onLeaseLost: vi.fn()
		});

		expect(await first.acquire()).toBe(true);
		expect(await second.acquire()).toBe(false);
		await first.release();
		expect(await second.acquire()).toBe(true);
		await second.release();
	});

	it("claims an expired lease left by a killed process", async () => {
		database = await createTestDatabase();
		const logger = createLogger("test", { level: "error", write: () => undefined });
		const crashed = new WorkerLease({
			client: database.client,
			hostLabel: "host",
			instanceId: "crashed",
			leaseDurationMs: 30,
			logger,
			onLeaseLost: vi.fn(),
			renewIntervalMs: 1_000
		});
		const replacement = new WorkerLease({
			client: database.client,
			hostLabel: "host",
			instanceId: "replacement",
			leaseDurationMs: 30,
			logger,
			onLeaseLost: vi.fn(),
			renewIntervalMs: 1_000
		});

		expect(await crashed.acquire()).toBe(true);
		expect(await replacement.acquireEventually(500, 10)).toBe(true);

		await crashed.release();
		await replacement.release();
	});
});
