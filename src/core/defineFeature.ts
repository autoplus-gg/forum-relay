import type { FeatureModule } from "@/core/types.js";

export function defineFeature<const TFeature extends FeatureModule>(feature: TFeature) {
	return feature;
}
