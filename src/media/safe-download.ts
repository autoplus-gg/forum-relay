import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, join } from "node:path";
import { RelayFailure } from "@/jobs/retry-policy.js";

const ALLOWED_GITHUB_MEDIA_HOSTS = new Set([
	"github.com",
	"github-production-user-asset-6210df.s3.amazonaws.com",
	"objects.githubusercontent.com",
	"private-user-images.githubusercontent.com",
	"raw.githubusercontent.com",
	"user-images.githubusercontent.com"
]);
const MAX_REDIRECTS = 5;

export interface SafeDownloadOptions {
	authorization?: string;
	directory: string;
	fetchImplementation?: typeof fetch;
	maxBytes: number;
	timeoutMs?: number;
	url: string;
}

export interface DownloadedFile {
	contentType: string;
	filename: string;
	path: string;
	size: number;
	url: string;
	cleanup(): void;
}

export function isRecognizedGitHubMediaUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && ALLOWED_GITHUB_MEDIA_HOSTS.has(url.hostname.toLocaleLowerCase("en-US"));
	} catch {
		return false;
	}
}

export async function downloadGitHubMedia(options: SafeDownloadOptions): Promise<DownloadedFile> {
	const fetchImplementation = options.fetchImplementation ?? fetch;
	const timeoutMs = options.timeoutMs ?? 30_000;
	let currentUrl = new URL(options.url);
	let response: Response | undefined;

	for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
		await validateRemoteUrl(currentUrl);
		const headers = new Headers();
		headers.set("accept", "application/vnd.github.v3+json");
		// GitHub attachment redirects are signed S3 URLs. Forwarding the GitHub
		// installation token there both leaks it and can invalidate S3's signature.
		if (options.authorization && shouldSendGitHubAuthorization(currentUrl)) {
			headers.set("authorization", options.authorization);
		}
		response = await fetchImplementation(currentUrl, {
			headers,
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs)
		});
		if (![301, 302, 303, 307, 308].includes(response.status)) {
			break;
		}
		const location = response.headers.get("location");
		if (!location || redirect === MAX_REDIRECTS) {
			throw new RelayFailure("GitHub media redirect chain is invalid or too long.", "invalid", "MEDIA_REDIRECT");
		}
		currentUrl = new URL(location, currentUrl);
	}

	if (!response?.ok || !response.body) {
		throw mediaFetchFailure(response?.status ?? 0);
	}

	const declaredLength = Number(response.headers.get("content-length") ?? "0");
	if (declaredLength > options.maxBytes) {
		throw new RelayFailure("GitHub media exceeds the Discord upload limit.", "invalid", "MEDIA_TOO_LARGE");
	}

	mkdirSync(options.directory, { recursive: true });
	const filename = safeFilename(currentUrl);
	const path = join(options.directory, `${crypto.randomUUID()}-${filename}`);
	let size = 0;

	try {
		const file = await open(path, "wx");
		const reader = response.body.getReader();
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) {
					break;
				}
				size += chunk.value.byteLength;
				if (size > options.maxBytes) {
					throw new RelayFailure("GitHub media exceeds the Discord upload limit.", "invalid", "MEDIA_TOO_LARGE");
				}
				await file.write(chunk.value);
			}
		} finally {
			reader.releaseLock();
			await file.close();
		}
		const contentType = await verifiedContentType(path, response.headers.get("content-type"));
		return {
			contentType,
			filename,
			path,
			size,
			url: currentUrl.toString(),
			cleanup: () => {
				if (existsSync(path)) {
					unlinkSync(path);
				}
			}
		};
	} catch (error) {
		if (existsSync(path)) {
			unlinkSync(path);
		}
		throw error;
	}
}

export function mediaFetchFailure(status: number) {
	const message = `GitHub media download failed with HTTP ${status}.`;
	if (status === 401 || status === 403) {
		return new RelayFailure(message, "authentication", "MEDIA_AUTH");
	}
	if (status === 404 || status === 410) {
		// Deleted attachments and private attachments hidden by GitHub both use
		// not-found responses. Neither should put the entire relay into backoff.
		return new RelayFailure(message, "not-found", "MEDIA_NOT_FOUND");
	}
	if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
		return new RelayFailure(message, "invalid", "MEDIA_FETCH");
	}
	return new RelayFailure(message, status === 429 ? "rate-limit" : "temporary", "MEDIA_FETCH");
}

function shouldSendGitHubAuthorization(url: URL) {
	const hostname = url.hostname.toLocaleLowerCase("en-US");
	if (hostname === "private-user-images.githubusercontent.com" && url.searchParams.has("jwt")) {
		return false;
	}
	return hostname === "github.com" || hostname.endsWith(".githubusercontent.com");
}

async function validateRemoteUrl(url: URL) {
	if (url.protocol !== "https:" || !ALLOWED_GITHUB_MEDIA_HOSTS.has(url.hostname.toLocaleLowerCase("en-US"))) {
		throw new RelayFailure("Only recognized GitHub-hosted HTTPS media may be fetched.", "invalid", "MEDIA_HOST");
	}

	const addresses = await lookup(url.hostname, { all: true, verbatim: true });
	if (addresses.length === 0 || addresses.some((address) => isForbiddenAddress(address.address))) {
		throw new RelayFailure("GitHub media resolved to a forbidden network address.", "invalid", "MEDIA_SSRF");
	}
}

export function isForbiddenAddress(address: string) {
	const normalized = address.toLocaleLowerCase("en-US");
	if (isIP(normalized) === 4) {
		const octets = normalized.split(".").map(Number);
		const first = octets[0] ?? 0;
		const second = octets[1] ?? 0;
		return (
			first === 0 ||
			first === 10 ||
			first === 127 ||
			(first === 100 && second >= 64 && second <= 127) ||
			(first === 169 && second === 254) ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 0) ||
			(first === 192 && second === 168) ||
			first >= 224
		);
	}
	if (isIP(normalized) === 6) {
		return (
			normalized === "::" ||
			normalized === "::1" ||
			normalized.startsWith("fc") ||
			normalized.startsWith("fd") ||
			normalized.startsWith("fe8") ||
			normalized.startsWith("fe9") ||
			normalized.startsWith("fea") ||
			normalized.startsWith("feb") ||
			normalized.startsWith("ff") ||
			normalized.startsWith("::ffff:")
		);
	}
	return true;
}

async function verifiedContentType(path: string, declared: string | null) {
	const handle = await open(path, "r");
	const buffer = Buffer.alloc(16);
	try {
		await handle.read(buffer, 0, buffer.length, 0);
	} finally {
		await handle.close();
	}

	const detected = sniffContentType(buffer);
	const normalizedDeclared = declared?.split(";")[0]?.trim().toLocaleLowerCase("en-US");
	if (detected && normalizedDeclared && normalizedDeclared !== "application/octet-stream" && detected !== normalizedDeclared) {
		throw new RelayFailure("GitHub media MIME type does not match its bytes.", "invalid", "MEDIA_MIME_MISMATCH");
	}
	return detected ?? normalizedDeclared ?? "application/octet-stream";
}

function sniffContentType(bytes: Uint8Array) {
	if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (Buffer.from(bytes.subarray(0, 6)).toString("ascii").startsWith("GIF8")) {
		return "image/gif";
	}
	if (
		Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
		Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	if (Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "%PDF") {
		return "application/pdf";
	}
	return undefined;
}

function safeFilename(url: URL) {
	const candidate = basename(decodeURIComponent(url.pathname)) || "github-attachment";
	return candidate.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "github-attachment";
}
