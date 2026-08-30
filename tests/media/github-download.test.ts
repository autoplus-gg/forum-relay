import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubMediaDownloader } from "@/media/github-download.js";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("GitHub media downloader", () => {
	it("loads a verified temporary image for a Discord webhook and cleans it up", async () => {
		const directory = mkdtempSync(join(tmpdir(), "forum-relay-download-"));
		directories.push(directory);
		const path = join(directory, "downloaded-asset");
		writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const authorizationFor = vi.fn(async () => "Bearer installation-token");
		const downloader = new GitHubMediaDownloader({
			authorizationFor,
			directory,
			downloadImplementation: async (options) => {
				expect(options.authorization).toBe("Bearer installation-token");
				return {
					cleanup: () => unlinkSync(path),
					contentType: "image/png",
					filename: "asset",
					path,
					size: 4,
					url: options.url
				};
			}
		});

		const result = await downloader.download(
			"feedback",
			"https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc"
		);

		expect(result.file.name).toMatch(/^[a-f0-9]{16}-asset\.png$/);
		expect(result.file.contentType).toBe("image/png");
		expect(result.file.data).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		expect(existsSync(path)).toBe(false);
		expect(authorizationFor).toHaveBeenCalledWith("feedback");
	});
});
