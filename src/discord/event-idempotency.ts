import { createHash } from "node:crypto";
import type { JsonValue } from "@/core/json.js";

export function discordEventIdempotencyKey(
	kind: string,
	sourceId: string,
	payload: JsonValue,
	occurrenceId: string = crypto.randomUUID()
) {
	if (kind === "message.update" || kind === "thread.update") {
		// Gateway update payloads have no delivery ID, and the same state can
		// legitimately recur after an intermediate edit. Each dispatch must enter
		// the durable inbox; downstream render hashes handle actual no-ops.
		return `discord:${kind}:${sourceId}:${occurrenceId}`;
	}
	const revision = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
	return `discord:${kind}:${sourceId}:${revision}`;
}
