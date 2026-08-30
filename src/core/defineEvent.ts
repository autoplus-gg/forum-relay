import type { EventModule } from "@/core/types.js";

export function defineEvent<const TEvent extends EventModule>(event: TEvent) {
	return event;
}
