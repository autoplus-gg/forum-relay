export type JsonPrimitive = boolean | null | number | string;
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export function parseJson(text: string): JsonValue {
	const value: JsonValue = JSON.parse(text);
	return value;
}

export function isJsonObject(value: JsonValue): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function jsonString(value: JsonValue, key: string) {
	if (!isJsonObject(value) || typeof value[key] !== "string") {
		return undefined;
	}

	return value[key];
}

export function jsonNumber(value: JsonValue, key: string) {
	if (!isJsonObject(value) || typeof value[key] !== "number") {
		return undefined;
	}

	return value[key];
}
