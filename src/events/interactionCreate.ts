import {
	GatewayDispatchEvents,
	type GatewayInteractionCreateDispatchData,
	InteractionType,
	type ToEventProps
} from "@discordjs/core";
import { defineEvent } from "@/core/defineEvent.js";

const interactionCreateEvent = defineEvent({
	name: GatewayDispatchEvents.InteractionCreate,
	async execute(app, event: ToEventProps<GatewayInteractionCreateDispatchData>) {
		if (event.data.type !== InteractionType.Ping) {
			try {
				await app.router.handleInteraction(event.data);
			} catch (error) {
				// An expired interaction or failed response must not become an
				// unhandled rejection that shuts down the entire relay worker.
				app.logger.error("Interaction handler failed.", {
					error: error instanceof Error ? error : String(error)
				});
			}
		}
	}
});

export default interactionCreateEvent;
