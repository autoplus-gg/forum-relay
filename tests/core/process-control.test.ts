import { describe, expect, it } from "vitest";
import { containsTerminalInterrupt } from "@/core/process-control.js";

describe("containsTerminalInterrupt", () => {
	it("recognizes Pterodactyl's Ctrl+C stop byte in text and binary chunks", () => {
		expect(containsTerminalInterrupt("\u0003")).toBe(true);
		expect(containsTerminalInterrupt(Buffer.from([0x03]))).toBe(true);
		expect(containsTerminalInterrupt(Buffer.from("ordinary console input"))).toBe(false);
	});
});
