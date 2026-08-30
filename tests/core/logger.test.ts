import { describe, expect, it } from "vitest";
import { createLogger } from "@/core/logger.js";

describe("createLogger", () => {
	it("writes structured records, applies levels, and redacts secrets", () => {
		const lines: string[] = [];
		const logger = createLogger("relay", {
			level: "info",
			write: (line) => lines.push(line)
		}).child({ correlationId: "correlation-1" });

		logger.debug("not emitted");
		logger.info("request bearer abc.def", {
			webhookToken: "secret",
			url: "https://example.com/file?signature=signed-value&safe=yes"
		});

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('"scope":"relay"');
		expect(lines[0]).toContain('"correlationId":"correlation-1"');
		expect(lines[0]).not.toContain("abc.def");
		expect(lines[0]).not.toContain("signed-value");
		expect(lines[0]).not.toContain('"webhookToken":"secret"');
	});
});
