import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { RawFile } from "@discordjs/rest";
import { RelayFailure } from "@/jobs/retry-policy.js";
import { downloadGitHubMedia } from "@/media/safe-download.js";

const MAX_GITHUB_IMAGE_BYTES = 10 * 1024 * 1024;
const EXTENSION_BY_CONTENT_TYPE = new Map([
	["image/gif", ".gif"],
	["image/jpeg", ".jpg"],
	["image/png", ".png"],
	["image/webp", ".webp"]
]);

export interface GitHubMediaDownloaderOptions {
	authorizationFor(mappingKey: string): Promise<string>;
	directory?: string;
	downloadImplementation?: typeof downloadGitHubMedia;
	fetchImplementation?: typeof fetch;
}

export interface DownloadedDiscordImage {
	file: RawFile;
	sourceUrl: string;
}

export class GitHubMediaDownloader {
	readonly #authorizationFor: GitHubMediaDownloaderOptions["authorizationFor"];
	readonly #directory: string;
	readonly #downloadImplementation: typeof downloadGitHubMedia;
	readonly #fetchImplementation?: typeof fetch;

	public constructor(options: GitHubMediaDownloaderOptions) {
		this.#authorizationFor = options.authorizationFor;
		this.#directory = options.directory ?? join(process.cwd(), ".data", "tmp", "github-media");
		this.#downloadImplementation = options.downloadImplementation ?? downloadGitHubMedia;
		this.#fetchImplementation = options.fetchImplementation;
	}

	public async download(mappingKey: string, sourceUrl: string): Promise<DownloadedDiscordImage> {
		const downloaded = await this.#downloadImplementation({
			authorization: await this.#authorizationFor(mappingKey),
			directory: this.#directory,
			fetchImplementation: this.#fetchImplementation,
			maxBytes: MAX_GITHUB_IMAGE_BYTES,
			url: sourceUrl
		});

		try {
			const expectedExtension = EXTENSION_BY_CONTENT_TYPE.get(downloaded.contentType);
			if (!expectedExtension) {
				throw new RelayFailure(
					`GitHub media type ${downloaded.contentType} cannot be displayed by Discord.`,
					"invalid",
					"MEDIA_TYPE"
				);
			}
			const currentExtension = extname(downloaded.filename).toLocaleLowerCase("en-US");
			const extension = currentExtension !== expectedExtension ? expectedExtension : "";
			const prefix = createHash("sha256").update(sourceUrl).digest("hex").slice(0, 16);
			return {
				file: {
					contentType: downloaded.contentType,
					data: await readFile(downloaded.path),
					name: `${prefix}-${downloaded.filename}${extension}`
				},
				sourceUrl
			};
		} finally {
			downloaded.cleanup();
		}
	}
}
