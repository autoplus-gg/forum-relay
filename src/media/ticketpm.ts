import { TicketPmMediaProxyClient } from "@ticketpm/core";
import { RelayFailure } from "@/jobs/retry-policy.js";

export interface ProxiedMedia {
	hash: string;
	url: string;
}

export class DiscordMediaProxy {
	readonly #client: TicketPmMediaProxyClient;

	public constructor(token?: string, fetchImplementation: typeof fetch = fetch) {
		this.#client = new TicketPmMediaProxyClient({
			baseUrl: "https://m.ticket.pm/v2",
			fetch: fetchImplementation,
			token
		});
	}

	public async uploadAttachment(sourceUrl: string): Promise<ProxiedMedia> {
		const url = await this.#client.uploadAttachmentUrl(sourceUrl);
		if (!url) {
			throw new RelayFailure("m.ticket.pm did not accept the attachment.", "temporary", "TICKETPM_UPLOAD_FAILED");
		}
		const hash = new URL(url).pathname.split("/").filter(Boolean).at(-1);
		if (!hash) {
			throw new RelayFailure("m.ticket.pm returned an invalid attachment URL.", "invalid", "TICKETPM_INVALID_URL");
		}
		return { hash, url };
	}
}
