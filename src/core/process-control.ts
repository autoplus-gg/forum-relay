const TERMINAL_INTERRUPT_BYTE = 3;

export function containsTerminalInterrupt(chunk: Uint8Array | string) {
	return typeof chunk === "string" ? chunk.includes("\u0003") : chunk.includes(TERMINAL_INTERRUPT_BYTE);
}
